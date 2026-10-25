import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  getLane,
  getMainLane,
  jobs,
  organizations,
  ralphRuns,
  seedReviewProfiles,
  updateLane,
  updateRun,
  upsertScmConnection,
  type Database,
  type RalphLane,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import type { ChangeMessage } from "@/lib/live/publisher";
import { withLiveChanges } from "@/lib/live/request";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { handleWebhook } from "./ingest";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const databaseAvailable = testDatabaseAvailable();

const human = { login: "octocat", type: "User" };
const appBot = { login: "omniralph[bot]", type: "Bot" };

describe.skipIf(!databaseAvailable)("PR/MR review and merge state from webhooks", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let githubRepo: string;
  let gitlabRepo: string;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await seedReviewProfiles(db, orgId);
    const key = randomBytes(32);
    const github = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      key,
    ))!;
    const gitlab = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "gitlab",
        name: "acme-gitlab",
        baseUrl: "https://gitlab.com",
        externalId: "gitlab-1",
        botUsername: "omniralph-bot",
        credentials: {},
      },
      key,
    ))!;
    githubRepo = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    gitlabRepo = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
  });

  /** A finished epic whose main lane in `repositoryId` has PR/MR `number`. */
  async function ralphLane(repositoryId: string, number: number): Promise<RalphLane> {
    session += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: `issue-${session}`,
      linearIdentifier: `ENG-${session}`,
      linearAgentSessionId: `session-${session}`,
      kind: "children",
      repositoryId,
      branch: `om/eng-${session}`,
      baseBranch: "main",
    });
    await updateRun(db, run.id, { status: "completed" });
    const lane = (await getMainLane(db, run))!;
    return (await updateLane(db, lane.id, {
      prNumber: number,
      prUrl: `https://example.com/${number}`,
    }))!;
  }

  const send = async (provider: "github" | "gitlab", event: string, body: object) => {
    const headers: Record<string, string> =
      provider === "github"
        ? { "x-github-event": event, "x-github-delivery": randomUUID() }
        : { "x-gitlab-event": event, "x-gitlab-event-uuid": randomUUID() };
    const req = new Request(`http://localhost/api/webhooks/${provider}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(
        provider === "github"
          ? { installation: { id: 1 }, repository: { id: 1, full_name: "acme/api" }, ...body }
          : { project: { id: 2, path_with_namespace: "acme/web" }, ...body },
      ),
    });
    const scm = new FakeScmAdapter(provider);
    const response = await handleWebhook(provider, req, {
      db,
      dispatcher: new PostgresDispatcher({ db }),
      adapterFor: () => scm.asAdapter(),
    });
    return response.json();
  };

  const pullRequest = (
    action: string,
    number: number,
    pr: { draft?: boolean; requested_reviewers?: object[]; updated_at?: string } = {},
  ) =>
    send("github", "pull_request", {
      action,
      pull_request: {
        number,
        state: "open",
        draft: false,
        title: "Build the epic",
        body: "Builds it.",
        user: human,
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
        requested_reviewers: [],
        requested_teams: [],
        ...pr,
      },
    });

  const review = (
    action: string,
    number: number,
    state: string,
    user: object = human,
    times: { submitted_at?: string; updated_at?: string } = {},
  ) =>
    send("github", "pull_request_review", {
      action,
      review: { state, user, submitted_at: times.submitted_at },
      pull_request: {
        number,
        state: "open",
        draft: false,
        requested_reviewers: [],
        updated_at: times.updated_at,
      },
    });

  const stateOf = async (lane: RalphLane) => {
    const current = (await getLane(db, lane.id))!;
    return [current.prDraft, current.prReviewState];
  };
  const accepted = { status: "accepted", event: "pull_request_state" };

  it("follows a GitHub PR from pull_request events alone (no pull_request_review subscription)", async () => {
    const lane = await ralphLane(githubRepo, 7);
    expect(lane).toMatchObject({ prDraft: false, prReviewState: "none", prStateUpdatedAt: null });

    expect(await pullRequest("converted_to_draft", 7, { draft: true })).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([true, "none"]);
    expect((await getLane(db, lane.id))!.prStateUpdatedAt).toBeInstanceOf(Date);

    // Ready for review also triggers a review, which goes on exactly as for another PR.
    const asBefore = await pullRequest("ready_for_review", 8, { requested_reviewers: [human] });
    const ready = await pullRequest("ready_for_review", 7, { requested_reviewers: [human] });
    expect(ready).not.toEqual(accepted);
    expect(ready.status).toBe(asBefore.status);
    expect(ready.reason).toBe(asBefore.reason);
    expect(await stateOf(lane)).toEqual([false, "review_requested"]);

    expect(await pullRequest("review_request_removed", 7)).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "none"]);
    expect(await pullRequest("review_requested", 7, { requested_reviewers: [human] })).toEqual(
      accepted,
    );
    expect(await stateOf(lane)).toEqual([false, "review_requested"]);
  });

  it("applies GitHub reviews, ignoring the app's own", async () => {
    const lane = await ralphLane(githubRepo, 9);
    await pullRequest("review_requested", 9, { requested_reviewers: [human] });

    expect(await review("submitted", 9, "changes_requested", appBot)).toEqual({
      status: "ignored",
      reason: "own_review",
    });
    expect(await stateOf(lane)).toEqual([false, "review_requested"]);

    expect(await review("submitted", 9, "changes_requested")).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "changes_requested"]);
    expect(await review("submitted", 9, "approved")).toEqual(accepted);
    // A later comment doesn't undo the approval.
    expect(await review("submitted", 9, "commented")).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "approved"]);
    // Dismissing the app's own review doesn't touch the human approval.
    expect(await review("dismissed", 9, "dismissed", appBot)).toEqual({
      status: "ignored",
      reason: "own_review",
    });
    expect(await stateOf(lane)).toEqual([false, "approved"]);
    expect(await review("dismissed", 9, "dismissed")).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "none"]);
    expect(await review("submitted", 9, "pending")).toEqual({
      status: "ignored",
      reason: "unsupported_event",
    });
  });

  it("ignores deliveries older than the lane's state (out of order)", async () => {
    const lane = await ralphLane(githubRepo, 11);
    expect(
      await review("submitted", 11, "approved", human, { submitted_at: "2026-10-25T10:05:00Z" }),
    ).toEqual(accepted);
    expect((await getLane(db, lane.id))!.prStateUpdatedAt).toEqual(
      new Date("2026-10-25T10:05:00Z"),
    );
    // The review request and draft flip from before the approval arrive late.
    expect(
      await pullRequest("review_requested", 11, {
        requested_reviewers: [human],
        updated_at: "2026-10-25T10:01:00Z",
      }),
    ).toEqual(accepted);
    expect(
      await pullRequest("converted_to_draft", 11, {
        draft: true,
        updated_at: "2026-10-25T10:02:00Z",
      }),
    ).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "approved"]);
    // A dismissal after the approval applies (it has the PR's update time).
    expect(
      await review("dismissed", 11, "dismissed", human, { updated_at: "2026-10-25T10:09:00Z" }),
    ).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "none"]);

    // GitLab's `updated_at` reads "2026-10-25 10:00:00 UTC".
    const mr = await ralphLane(gitlabRepo, 12);
    const gitlab = (action: string, updatedAt: string) =>
      send("gitlab", "Merge Request Hook", {
        object_kind: "merge_request",
        user: { id: 5, username: "alice" },
        reviewers: [],
        object_attributes: { iid: 12, action, state: "opened", updated_at: updatedAt },
      });
    expect(await gitlab("approved", "2026-10-25 10:05:00 UTC")).toEqual(accepted);
    expect(await gitlab("unapproved", "2026-10-25 10:01:00 UTC")).toEqual(accepted);
    expect(await stateOf(mr)).toEqual([false, "approved"]);
    expect(await gitlab("unapproved", "2026-10-25 10:06:00 UTC")).toEqual(accepted);
    expect(await stateOf(mr)).toEqual([false, "none"]);
  });

  it("publishes a pull_request change with the lane's and run's IDs", async () => {
    const lane = await ralphLane(githubRepo, 13);
    const published: ChangeMessage[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    await withLiveChanges(
      () => pullRequest("review_requested", 13, { requested_reviewers: [human] }),
      {
        publisher: {
          publish: async (messages) => {
            published.push(...messages);
          },
        },
        schedule: (task) => scheduled.push(task),
      },
    );
    for (const task of scheduled) await task();
    expect(published.filter((m) => m.event.resource === "pull_request")).toEqual([
      {
        channel: `org:${orgId}:changes`,
        event: expect.objectContaining({
          resource: "pull_request",
          ids: [lane.id],
          runId: lane.runId,
          organizationId: orgId,
        }),
      },
    ]);
    expect(published).toContainEqual({
      channel: `org:${orgId}:changes`,
      event: expect.objectContaining({ resource: "run", ids: [lane.runId] }),
    });
  });

  it("ignores PRs that aren't a ralph lane's, and closed lanes", async () => {
    expect(await review("submitted", 99, "approved")).toEqual({
      status: "ignored",
      reason: "not_ralph",
    });
    expect(await pullRequest("converted_to_draft", 99, { draft: true })).toEqual({
      status: "ignored",
      reason: "not_ralph",
    });
    const lane = await ralphLane(githubRepo, 10);
    await updateLane(db, lane.id, { prClosed: true, prMerged: true });
    expect(await review("submitted", 10, "approved")).toEqual({
      status: "ignored",
      reason: "not_ralph",
    });
    expect(await stateOf(lane)).toEqual([false, "none"]);
  });

  const mergeRequest = (
    action: string,
    number: number,
    extra: {
      user?: { id: number; username: string };
      reviewers?: object[];
      draft?: boolean;
      changes?: object;
    } = {},
  ) =>
    send("gitlab", "Merge Request Hook", {
      object_kind: "merge_request",
      user: extra.user ?? { id: 7, username: "reviewer" },
      reviewers: extra.reviewers ?? [],
      object_attributes: {
        iid: number,
        action,
        state: "opened",
        title: "Build the epic",
        description: "Builds it.",
        draft: extra.draft ?? false,
        last_commit: { id: "c".repeat(40) },
      },
      ...(extra.changes ? { changes: extra.changes } : {}),
    });

  it("follows a GitLab MR's approvals, draft flag and reviewers, ignoring the bot's", async () => {
    const lane = await ralphLane(gitlabRepo, 3);
    const reviewer = { id: 7, username: "reviewer" };

    expect(
      await mergeRequest("update", 3, {
        draft: true,
        changes: { draft: { previous: false, current: true } },
      }),
    ).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([true, "none"]);
    // Out of draft also triggers a review, as before.
    expect(
      await mergeRequest("update", 3, {
        reviewers: [reviewer],
        changes: {
          draft: { previous: true, current: false },
          reviewers: { previous: [], current: [reviewer] },
        },
      }),
    ).not.toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "review_requested"]);

    expect(
      await mergeRequest("approved", 3, { user: { id: 1, username: "omniralph-bot" } }),
    ).toEqual({ status: "ignored", reason: "own_review" });
    expect(await stateOf(lane)).toEqual([false, "review_requested"]);
    expect(await mergeRequest("approval", 3)).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "approved"]);
    expect(await mergeRequest("unapproval", 3, { reviewers: [reviewer] })).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "review_requested"]);
    expect(await mergeRequest("approved", 3)).toEqual(accepted);
    expect(await mergeRequest("unapproved", 3)).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "none"]);
    expect(
      await mergeRequest("update", 3, {
        changes: { reviewers: { previous: [], current: [reviewer] } },
      }),
    ).toEqual(accepted);
    expect(await stateOf(lane)).toEqual([false, "review_requested"]);

    expect(await mergeRequest("approved", 98)).toEqual({ status: "ignored", reason: "not_ralph" });
  });
});
