import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  getJob,
  getTriageRunBySession,
  jobs,
  organizations,
  ralphRuns,
  runMigrations,
  seedReviewProfiles,
  triageRuns,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  type Database,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import { TriageRunPayload } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { handleLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { TriageDeps } from "./start";
import { startTriage, type SessionCreatedEvent } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("starting triage from an @omniralph /triage mention", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let linear: FakeLinearGateway;
  let publisher: RecordingPublisher;
  let sessionSeq = 0;

  const fakeAdapter = {
    getDefaultBranch: async () => "develop",
  } as unknown as ScmAdapter;

  const deps = (): TriageDeps => ({
    db,
    organizationId: orgId,
    linear,
    dispatcher: new VercelQueuesDispatcher({ db, publisher }),
    adapterFor: () => fakeAdapter,
  });

  const mention = (
    issueId: string,
    commentBody = "@omniralph /triage",
    overrides: Partial<SessionCreatedEvent> = {},
  ): SessionCreatedEvent => {
    sessionSeq += 1;
    return {
      kind: "session_created",
      sessionId: `triage-session-${sessionSeq}`,
      issueId,
      commentBody,
      creatorName: "Steve",
      ...overrides,
    };
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    await updateRepositoryRalphSettings(db, repoId, {
      ralphEnabled: true,
      linearTeamKeys: [],
      linearProjectNames: [],
      linearLabels: ["backend"],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(triageRuns);
    await db.delete(jobs);
    await db.delete(ralphRuns);
    linear = new FakeLinearGateway();
    publisher = new RecordingPublisher();
  });

  /** The queued job's payload, parsed. */
  const payloadOf = async (jobId: string) =>
    TriageRunPayload.parse((await getJob(db, jobId))!.payload);

  it("queues a triage.run job for a routed issue with its comments, children and blockers", async () => {
    const issue = linear.add({
      identifier: "ENG-1",
      title: "Priorities",
      description: "Let people set a priority.",
      stateType: "backlog",
      labels: ["Backend"],
      creator: { id: "user-1", name: "Ada" },
    });
    const child = linear.add({
      identifier: "ENG-2",
      title: "Store it",
      parentId: issue.id,
      stateType: "unstarted",
      priority: 2,
    });
    linear.add({
      identifier: "ENG-3",
      title: "Dropped",
      parentId: issue.id,
      stateType: "canceled",
    });
    const blocker = linear.add({ identifier: "ENG-9", title: "Schema", stateType: "started" });
    await linear.createBlocksRelation(blocker.id, child.id);
    linear.commentsByIssue.set(issue.id, [
      { body: "Only admins can set it.", author: "Bo", createdAt: "2026-10-01T00:00:00.000Z" },
    ]);

    const event = mention(issue.id, "@omniralph /triage it's for the API");
    // Through the webhook handler: `/triage` goes to triage, not to ralph.
    await handleLinearEvent(
      event,
      { db, organizationId: orgId, workspaceId: "ws-1" },
      {
        linear,
        dispatcher: new VercelQueuesDispatcher({ db, publisher }),
        adapterFor: () => fakeAdapter,
      },
    );

    const run = await getTriageRunBySession(db, event.sessionId);
    expect(run).toMatchObject({
      organizationId: orgId,
      linearIssueId: issue.id,
      trigger: "mention",
      status: "queued",
    });
    expect(await db.select().from(ralphRuns)).toEqual([]);
    expect(run!.currentJobId).not.toBeNull();

    const job = (await getJob(db, run!.currentJobId!))!;
    expect(job).toMatchObject({
      capability: "triage",
      type: "triage.run",
      repositoryId: repoId,
      organizationId: orgId,
    });
    expect(publisher.sent).toEqual([{ topic: `triage-jobs-org-${orgId}`, jobId: job.id }]);

    const payload = await payloadOf(job.id);
    expect(payload).toMatchObject({
      triageRunId: run!.id,
      issue: {
        id: issue.id,
        identifier: "ENG-1",
        title: "Priorities",
        description: "Let people set a priority.",
        stateType: "backlog",
        creator: { id: "user-1", name: "Ada" },
      },
      comments: [
        { author: "Bo", body: "Only admins can set it.", createdAt: "2026-10-01T00:00:00.000Z" },
      ],
      repository: {
        repositoryId: repoId,
        repository: {
          provider: "github",
          fullPath: "acme/api",
          cloneUrl: "https://github.com/acme/api.git",
        },
        defaultBranch: "develop",
      },
      reply: "it's for the API",
      previousResult: null,
    });
    expect(payload.children.map((c) => [c.identifier, c.stateType, c.priority])).toEqual([
      ["ENG-2", "unstarted", 2],
      ["ENG-3", "canceled", 0],
    ]);
    expect(payload.blockers).toEqual([
      { identifier: "ENG-9", title: "Schema", stateType: "started", blocks: "ENG-2" },
    ]);

    const [thought] = linear.bodies(event.sessionId, "thought");
    expect(thought).toContain("`acme/api` (routed by label `Backend`) at `develop`");
    expect(linear.bodies(event.sessionId, "error")).toEqual([]);
    // Starting triage changes nothing in Linear.
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
  });

  it("queues an unrouted issue without a repository", async () => {
    const issue = linear.add({ identifier: "OPS-1", title: "Rotate keys", teamKey: "OPS" });
    const event = mention(issue.id);

    const outcome = await startTriage(event, deps());
    expect(outcome).toMatchObject({ status: "queued", repository: null });

    const run = await getTriageRunBySession(db, event.sessionId);
    const job = (await getJob(db, run!.currentJobId!))!;
    expect(job.repositoryId).toBeNull();
    expect(publisher.sent).toEqual([{ topic: `triage-jobs-org-${orgId}`, jobId: job.id }]);
    const payload = await payloadOf(job.id);
    expect(payload.repository).toBeNull();
    expect(payload.reply).toBeNull();
    expect(payload.issue.creator).toBeNull();
    expect(linear.bodies(event.sessionId, "thought")[0]).toContain("No repository routes it");

    // A redelivered event doesn't queue a second job.
    expect(await startTriage(event, deps())).toMatchObject({ status: "exists" });
    expect(publisher.sent).toHaveLength(1);
  });

  it("changes nothing for an issue in progress", async () => {
    const issue = linear.add({
      identifier: "ENG-20",
      title: "Busy",
      stateType: "started",
      labels: ["backend"],
    });
    const event = mention(issue.id);

    const outcome = await startTriage(event, deps());
    expect(outcome).toEqual({ status: "in_progress", issues: ["ENG-20"] });
    expect(await getTriageRunBySession(db, event.sessionId)).toBeNull();
    expect(await db.select().from(jobs)).toEqual([]);
    expect(publisher.sent).toEqual([]);
    const [response] = linear.bodies(event.sessionId, "response");
    expect(response).toContain("**ENG-20** is already in progress or done");
    expect(response).toContain("changed nothing in Linear");
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
    expect(linear.labelChanges).toEqual([]);
    expect(linear.comments).toEqual([]);
  });

  it("changes nothing for an epic with a done child", async () => {
    const epic = linear.add({ identifier: "ENG-30", title: "Epic", stateType: "backlog" });
    linear.add({ identifier: "ENG-31", title: "Open", parentId: epic.id });
    linear.add({ identifier: "ENG-32", title: "Done", parentId: epic.id, stateType: "completed" });
    linear.add({
      identifier: "ENG-33",
      title: "Dropped",
      parentId: epic.id,
      stateType: "canceled",
    });
    const event = mention(epic.id);

    const outcome = await startTriage(event, deps());
    expect(outcome).toEqual({ status: "in_progress", issues: ["ENG-32"] });
    expect(await db.select().from(jobs)).toEqual([]);
    expect(await db.select().from(triageRuns)).toEqual([]);
    expect(linear.bodies(event.sessionId, "response")[0]).toContain(
      "**ENG-32** is already in progress or done, so I didn't triage **ENG-30**",
    );
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
  });

  it("refuses a second session while the issue is being triaged", async () => {
    const issue = linear.add({ identifier: "OPS-2", title: "Twice", teamKey: "OPS" });
    await startTriage(mention(issue.id), deps());
    const second = mention(issue.id);

    expect(await startTriage(second, deps())).toMatchObject({ status: "already_running" });
    expect(publisher.sent).toHaveLength(1);
    expect(linear.bodies(second.sessionId, "response")[0]).toContain(
      "already being triaged in another session",
    );
  });

  it("sends a mention without /triage to ralph", async () => {
    const issue = linear.add({ identifier: "OPS-3", title: "Ralph", teamKey: "OPS" });
    const event = mention(issue.id, "@omniralph /ralph");
    await handleLinearEvent(
      event,
      { db, organizationId: orgId, workspaceId: "ws-1" },
      {
        linear,
        dispatcher: new VercelQueuesDispatcher({ db, publisher }),
        adapterFor: () => fakeAdapter,
      },
    );
    expect(await db.select().from(triageRuns)).toEqual([]);
    expect(await db.select().from(ralphRuns)).toHaveLength(1);
  });
});
