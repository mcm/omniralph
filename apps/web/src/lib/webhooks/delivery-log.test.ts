import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  createTriageRun,
  getMainLane,
  integrations,
  jobs,
  organizations,
  ralphRuns,
  repositories,
  reviews,
  saveIntegration,
  seedReviewProfiles,
  setRepositorySwitches,
  updateLane,
  updateRun,
  upsertScmConnection,
  webhookDeliveries,
  webhookEvents,
  type Database,
  type ScmConnection,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDispatcher } from "@/lib/dispatch";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import type { HandledLinearEvent, LinearEventContext } from "@/lib/linear/events";
import { handleLinearWebhook } from "@/lib/linear/ingest";
import { signBody } from "@/lib/linear/webhook";
import type { ChangeMessage } from "@/lib/live/publisher";
import { withLiveChanges } from "@/lib/live/request";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { handleWebhook } from "./ingest";
import { describeIgnoreReason } from "./reasons";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const databaseAvailable = testDatabaseAvailable();

const LINEAR_SECRET = "linear-secret";
const human = { login: "octocat", type: "User" };

/** The fake code host, which can also post (and fail to post) PR comments. */
class CommentingAdapter extends FakeScmAdapter {
  readonly posted: string[] = [];
  postFailure: string | null = null;

  async postComment(_repo: unknown, _number: number, body: string): Promise<void> {
    if (this.postFailure) throw new Error(this.postFailure);
    this.posted.push(body);
  }
}

describe.skipIf(!databaseAvailable)("webhook delivery log", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let github: ScmConnection;
  let gitlab: ScmConnection;
  let githubRepo: string;
  let gitlabRepo: string;
  let integrationId: string;
  let scm: CommentingAdapter;
  let counter = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await seedReviewProfiles(db, orgId);
    const key = randomBytes(32);
    github = (await upsertScmConnection(
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
    gitlab = (await upsertScmConnection(
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
    await db.delete(webhookEvents);
    await db.delete(webhookDeliveries);
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(integrations);
    const integration = await saveIntegration(db, {
      organizationId: orgId,
      provider: "linear",
      externalId: "workspace-1",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("workspace taken");
    integrationId = integration.id;
    for (const id of [githubRepo, gitlabRepo]) {
      await db
        .update(repositories)
        .set({ enabled: null, triggers: { onOpen: true, onPush: true, drafts: false } })
        .where(eq(repositories.id, id));
    }
    await setRepositorySwitches(db, orgId, githubRepo, { coding: null });
    scm = new CommentingAdapter("github");
  });

  const events = () => db.select().from(webhookEvents).orderBy(webhookEvents.receivedAt);
  const onlyEvent = async () => {
    const rows = await events();
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  type Send = {
    event?: string;
    delivery?: string;
    defer?: (task: () => Promise<void>) => void | Promise<void>;
    dispatcher?: JobDispatcher;
    raw?: string;
  };

  async function sendGitHub(body: object, opts: Send = {}) {
    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": opts.event ?? "pull_request",
        "x-github-delivery": opts.delivery ?? randomUUID(),
      },
      body:
        opts.raw ??
        JSON.stringify({
          installation: { id: 1 },
          repository: { id: 1, full_name: "acme/api" },
          ...body,
        }),
    });
    return handleWebhook("github", req, {
      db,
      dispatcher: opts.dispatcher ?? new PostgresDispatcher({ db }),
      adapterFor: () => scm.asAdapter(),
      ...(opts.defer && { defer: opts.defer }),
    });
  }

  async function sendGitLab(body: object, opts: Send = {}) {
    const req = new Request("http://localhost/api/webhooks/gitlab", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": opts.event ?? "Merge Request Hook",
        "x-gitlab-event-uuid": opts.delivery ?? randomUUID(),
      },
      body: JSON.stringify({ project: { id: 2, path_with_namespace: "acme/web" }, ...body }),
    });
    const adapter = new FakeScmAdapter("gitlab");
    return handleWebhook("gitlab", req, {
      db,
      dispatcher: new PostgresDispatcher({ db }),
      adapterFor: () => adapter.asAdapter(),
    });
  }

  const pullRequest = (action: string, number: number, pr: object = {}) => ({
    action,
    pull_request: {
      number,
      state: "open",
      draft: false,
      title: "Add login",
      body: "Please review",
      user: human,
      head: { sha: randomBytes(20).toString("hex") },
      base: { sha: "b".repeat(40) },
      requested_reviewers: [],
      requested_teams: [],
      ...pr,
    },
  });

  const comment = (number: number, body: string, user: object = human) => ({
    action: "created",
    issue: { number, pull_request: {} },
    comment: { id: ++counter, body, user },
  });

  /** A finished epic whose main lane in `repositoryId` has PR/MR `number`. */
  async function ralphLane(repositoryId: string, number: number) {
    counter += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: `issue-${counter}`,
      linearIdentifier: `ENG-${counter}`,
      linearAgentSessionId: `session-${counter}`,
      kind: "children",
      repositoryId,
      branch: `om/eng-${counter}`,
      baseBranch: "main",
    });
    await updateRun(db, run.id, { status: "completed" });
    const lane = (await getMainLane(db, run))!;
    await updateLane(db, lane.id, { prNumber: number, prUrl: `https://example.com/${number}` });
    return run;
  }

  describe("code hosts", () => {
    it("records a review that started a run, with the delivery's details and payload", async () => {
      const delivery = randomUUID();
      const res = await sendGitHub(pullRequest("opened", 1), { delivery });
      const body = (await res.json()) as { status: string; reviewId: string };
      expect(body.status).toBe("enqueued");
      const [review] = await db.select().from(reviews).where(eq(reviews.id, body.reviewId));

      const row = await onlyEvent();
      expect(row).toMatchObject({
        organizationId: orgId,
        provider: "github",
        scmConnectionId: github.id,
        integrationId: null,
        repositoryId: githubRepo,
        deliveryId: delivery,
        event: "pull_request.opened",
        outcome: "started_run",
        reasonCode: null,
        reason: null,
        runId: review!.reviewRunId,
        runKind: "review",
        payloadTruncated: false,
        replayOfId: null,
      });
      expect(row.payload).toMatchObject({ action: "opened", pull_request: { number: 1 } });
    });

    it("records a redelivery as a duplicate", async () => {
      const delivery = randomUUID();
      const payload = pullRequest("opened", 2);
      await sendGitHub(payload, { delivery });
      expect(await (await sendGitHub(payload, { delivery })).json()).toEqual({
        status: "duplicate",
      });
      const rows = await events();
      expect(rows.map((r) => [r.deliveryId, r.outcome])).toEqual([
        [delivery, "started_run"],
        [delivery, "duplicate"],
      ]);
    });

    it("records a CI failure handed to its ralph run", async () => {
      const run = await ralphLane(githubRepo, 3);
      const res = await sendGitHub(
        {
          action: "completed",
          workflow_run: {
            head_sha: "head1",
            head_branch: "feature",
            conclusion: "failure",
            pull_requests: [{ number: 3 }],
          },
        },
        // The CI work runs after the response; here it never does.
        { event: "workflow_run", defer: () => undefined },
      );
      expect(await res.json()).toEqual({ status: "accepted", event: "ci_failure" });
      expect(await onlyEvent()).toMatchObject({
        event: "workflow_run.completed",
        outcome: "updated_run",
        runId: run.id,
        runKind: "epic",
      });
    });

    it("records a PR state change of a ralph PR against its run", async () => {
      const run = await ralphLane(githubRepo, 4);
      await sendGitHub(pullRequest("converted_to_draft", 4, { draft: true }));
      expect(await onlyEvent()).toMatchObject({
        event: "pull_request.converted_to_draft",
        outcome: "updated_run",
        runId: run.id,
        runKind: "epic",
      });
    });

    const reasonCases: Array<{
      code: string;
      send: () => Promise<Response>;
      before?: () => Promise<void>;
    }> = [
      {
        code: "unsupported_event",
        send: () => sendGitHub(pullRequest("edited", 10)),
      },
      {
        code: "repository_disabled",
        before: async () => {
          await db
            .update(repositories)
            .set({ enabled: false })
            .where(eq(repositories.id, githubRepo));
        },
        send: () => sendGitHub(pullRequest("opened", 11)),
      },
      {
        code: "trigger_disabled",
        before: async () => {
          await db
            .update(repositories)
            .set({ triggers: { onOpen: false, onPush: true, drafts: false } })
            .where(eq(repositories.id, githubRepo));
        },
        send: () => sendGitHub(pullRequest("opened", 12)),
      },
      { code: "draft", send: () => sendGitHub(pullRequest("opened", 13, { draft: true })) },
      {
        code: "no_review_tasks",
        before: async () => {
          await db
            .update(repositories)
            .set({ reviewTaskIds: [] })
            .where(eq(repositories.id, githubRepo));
        },
        send: () => sendGitHub(pullRequest("opened", 14)),
      },
      {
        code: "own_comment",
        send: () =>
          sendGitHub(comment(15, "@omniralph help", { login: "omniralph[bot]", type: "Bot" }), {
            event: "issue_comment",
          }),
      },
      {
        code: "no_mention",
        send: () => sendGitHub(comment(16, "Looks good"), { event: "issue_comment" }),
      },
      {
        code: "ci_not_failed",
        send: () =>
          sendGitHub(
            {
              action: "completed",
              workflow_run: { head_sha: "h", conclusion: "success", pull_requests: [] },
            },
            { event: "workflow_run" },
          ),
      },
      {
        code: "ralph_disabled",
        before: async () => {
          await setRepositorySwitches(db, orgId, githubRepo, { coding: false });
        },
        send: () =>
          sendGitHub(
            {
              action: "completed",
              workflow_run: { head_sha: "h", conclusion: "failure", pull_requests: [] },
            },
            { event: "workflow_run" },
          ),
      },
      {
        code: "not_ralph",
        send: () => sendGitHub(pullRequest("closed", 17, { state: "closed", merged: false })),
      },
      {
        code: "own_review",
        send: () =>
          sendGitHub(
            {
              action: "submitted",
              review: { state: "approved", user: { login: "omniralph[bot]", type: "Bot" } },
              pull_request: { number: 18, state: "open", draft: false, requested_reviewers: [] },
            },
            { event: "pull_request_review" },
          ),
      },
    ];

    for (const { code, send, before } of reasonCases) {
      it(`records an ignored delivery with its reason (${code})`, async () => {
        try {
          await before?.();
          const res = await send();
          expect(await res.json()).toEqual({ status: "ignored", reason: code });
          expect(await onlyEvent()).toMatchObject({
            outcome: "ignored",
            reasonCode: code,
            reason: describeIgnoreReason(code as never, "github"),
            scmConnectionId: github.id,
          });
        } finally {
          await db
            .update(repositories)
            .set({ reviewTaskIds: (await defaultReviewTasks()) ?? [] })
            .where(eq(repositories.id, githubRepo));
        }
      });
    }

    let reviewTaskIds: string[] | null = null;
    async function defaultReviewTasks() {
      if (!reviewTaskIds) {
        const [repo] = await db
          .select({ ids: repositories.reviewTaskIds })
          .from(repositories)
          .where(eq(repositories.id, gitlabRepo));
        reviewTaskIds = repo!.ids;
      }
      return reviewTaskIds;
    }

    it("names GitLab events with their action and the MR term in reasons", async () => {
      const res = await sendGitLab({
        object_kind: "merge_request",
        user: { username: "pusher" },
        object_attributes: {
          iid: 5,
          action: "close",
          state: "closed",
          last_commit: { id: "c".repeat(40) },
        },
      });
      expect(await res.json()).toEqual({ status: "ignored", reason: "not_ralph" });
      expect(await onlyEvent()).toMatchObject({
        provider: "gitlab",
        scmConnectionId: gitlab.id,
        repositoryId: gitlabRepo,
        event: "Merge Request Hook.close",
        outcome: "ignored",
        reason: "Om didn't open this merge request",
      });
    });

    it("records a handler failure as failed with its message", async () => {
      const failing: JobDispatcher = {
        createAndPublish: () => Promise.reject(new Error("database unavailable")),
        cancel: async () => undefined,
        republish: async () => undefined,
      } as unknown as JobDispatcher;
      const res = await sendGitHub(pullRequest("opened", 20), { dispatcher: failing });
      expect(res.status).toBe(500);
      expect(await onlyEvent()).toMatchObject({
        outcome: "failed",
        reasonCode: "handler_failed",
        reason: "database unavailable",
        runId: null,
      });
    });

    it("settles a deferred command's outcome after the response", async () => {
      const deferred: Array<() => Promise<void>> = [];
      const defer = (task: () => Promise<void>) => {
        deferred.push(task);
      };
      const res = await sendGitHub(comment(21, "@omniralph help"), {
        event: "issue_comment",
        defer,
      });
      expect(await res.json()).toEqual({ status: "accepted", command: "help" });
      expect(await onlyEvent()).toMatchObject({ outcome: "updated_run" });
      await deferred.shift()!();
      expect(scm.posted).toHaveLength(1);
      expect(await onlyEvent()).toMatchObject({ outcome: "ignored", reasonCode: "help" });

      await db.delete(webhookEvents);
      scm.postFailure = "GitHub is unavailable";
      await sendGitHub(comment(22, "@omniralph help"), { event: "issue_comment", defer });
      await deferred.shift()!();
      expect(await onlyEvent()).toMatchObject({
        outcome: "failed",
        reason: "GitHub is unavailable",
      });

      // Run before the response (no `defer`), the failure is in the row as written.
      await db.delete(webhookEvents);
      const inline = await sendGitHub(comment(23, "@omniralph help"), { event: "issue_comment" });
      expect(await inline.json()).toEqual({ status: "accepted", command: "help" });
      expect(await onlyEvent()).toMatchObject({ outcome: "failed" });
    });

    it("records nothing for unverified deliveries or unknown repositories", async () => {
      scm.webhookValid = false;
      expect((await sendGitHub(pullRequest("opened", 30))).status).toBe(401);
      scm.webhookValid = true;
      const unknown = await sendGitHub({
        ...pullRequest("opened", 31),
        repository: { id: 999, full_name: "acme/other" },
      });
      expect(await unknown.json()).toEqual({ status: "ignored", reason: "unknown_repository" });
      expect(await events()).toEqual([]);
    });

    it("stores a body over 256 KB without its payload", async () => {
      const res = await sendGitHub({
        ...pullRequest("opened", 40),
        padding: "x".repeat(300 * 1024),
      });
      expect((await res.json()) as object).toMatchObject({ status: "enqueued" });
      expect(await onlyEvent()).toMatchObject({
        payload: null,
        payloadTruncated: true,
        outcome: "started_run",
        event: "pull_request.opened",
      });
    });

    it("publishes a webhook_event change with the event's and connection's IDs", async () => {
      const published: ChangeMessage[] = [];
      const scheduled: Array<() => Promise<void>> = [];
      await withLiveChanges(() => sendGitHub(pullRequest("edited", 50)), {
        publisher: {
          publish: async (messages) => {
            published.push(...messages);
          },
        },
        schedule: (task) => scheduled.push(task),
      });
      for (const task of scheduled) await task();
      const row = await onlyEvent();
      const webhook = published.filter((m) => m.event.resource === "webhook_event");
      expect(webhook).toEqual([
        {
          channel: `org:${orgId}:changes`,
          event: expect.objectContaining({
            resource: "webhook_event",
            ids: [row.id, github.id],
            organizationId: orgId,
          }),
        },
      ]);
    });
  });

  describe("Linear", () => {
    let handler: (event: HandledLinearEvent, context: LinearEventContext) => Promise<void>;

    beforeEach(() => {
      handler = async () => undefined;
    });

    async function sendLinear(
      payload: Record<string, unknown>,
      opts: { delivery?: string; signature?: string } = {},
    ) {
      const body = JSON.stringify({
        organizationId: "workspace-1",
        webhookTimestamp: Date.now(),
        ...payload,
      });
      const req = new Request("http://localhost/api/webhooks/linear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": opts.signature ?? signBody(body, LINEAR_SECRET),
          "linear-delivery": opts.delivery ?? randomUUID(),
        },
        body,
      });
      return handleLinearWebhook(req, {
        db,
        secret: LINEAR_SECRET,
        handle: (event, context) => handler(event, context),
      });
    }

    const session = (action: string, sessionId: string, extra: object = {}) => ({
      type: "AgentSessionEvent",
      action,
      agentSession: { id: sessionId, issue: { id: `issue-${sessionId}`, identifier: "TOOL-1" } },
      ...extra,
    });

    it("records a session that started a run, with the run the handler created", async () => {
      let runId = "";
      handler = async (event) => {
        if (event.kind !== "session_created") return;
        const { run } = await createRun(db, {
          organizationId: orgId,
          linearIssueId: event.issueId,
          linearIdentifier: "TOOL-1",
          linearAgentSessionId: event.sessionId,
          kind: "children",
          repositoryId: githubRepo,
          branch: "om/tool-1",
          baseBranch: "main",
        });
        runId = run.id;
      };
      const delivery = randomUUID();
      expect(await (await sendLinear(session("created", "s-1"), { delivery })).json()).toEqual({
        status: "accepted",
        kind: "session_created",
      });
      expect(await onlyEvent()).toMatchObject({
        provider: "linear",
        integrationId,
        scmConnectionId: null,
        repositoryId: null,
        deliveryId: delivery,
        event: "AgentSessionEvent.created",
        outcome: "started_run",
        runId,
        runKind: "epic",
      });

      // A redelivery is a duplicate.
      expect(await (await sendLinear(session("created", "s-1"), { delivery })).json()).toEqual({
        status: "duplicate",
      });
      expect((await events()).map((r) => r.outcome)).toEqual(["started_run", "duplicate"]);
    });

    it("links a reply to its triage run", async () => {
      const { run: triage } = await createTriageRun(db, {
        organizationId: orgId,
        linearIssueId: "issue-t",
        linearAgentSessionId: "s-triage",
        trigger: "mention",
      });
      await sendLinear(
        session("prompted", "s-triage", { agentActivity: { content: { body: "Yes" } } }),
      );
      expect(await onlyEvent()).toMatchObject({
        event: "AgentSessionEvent.prompted",
        outcome: "updated_run",
        runId: triage.id,
        runKind: "triage",
      });
    });

    it("records a session event that reached no run as ignored", async () => {
      await sendLinear(session("created", "s-none"));
      expect(await onlyEvent()).toMatchObject({ outcome: "ignored", reasonCode: "no_run" });
    });

    it("records a handler failure as failed with its message", async () => {
      handler = async () => {
        throw new Error("Linear is unavailable");
      };
      await sendLinear(session("created", "s-2"));
      expect(await onlyEvent()).toMatchObject({
        outcome: "failed",
        reasonCode: "handler_failed",
        reason: "Linear is unavailable",
      });
    });

    const ignoredCases: Array<[string, Record<string, unknown>]> = [
      ["unsupported_event", { type: "Comment", action: "create" }],
      ["unsupported_event", session("updated", "s-3")],
      ["no_agent_session", { type: "AgentSessionEvent", action: "created", agentSession: {} }],
      [
        "agent_session_without_issue",
        { type: "AgentSessionEvent", action: "created", agentSession: { id: "s-4" } },
      ],
      ["issue_without_id", { type: "Issue", action: "update", data: {} }],
      ["issue_unchanged", { type: "Issue", action: "update", data: { id: "i" }, updatedFrom: {} }],
    ];
    for (const [code, payload] of ignoredCases) {
      it(`records an ignored event with its reason (${code}, ${String(payload.type)}.${String(payload.action)})`, async () => {
        const res = await sendLinear(payload);
        expect(await res.json()).toMatchObject({ status: "ignored" });
        expect(await onlyEvent()).toMatchObject({
          outcome: "ignored",
          reasonCode: code,
          reason: describeIgnoreReason(code as never, "linear"),
          event: `${String(payload.type)}.${String(payload.action)}`,
        });
      });
    }

    it("records nothing for unverified deliveries or unknown workspaces", async () => {
      expect((await sendLinear(session("created", "s-5"), { signature: "bad" })).status).toBe(401);
      expect(
        await (await sendLinear({ ...session("created", "s-6"), organizationId: "other" })).json(),
      ).toEqual({ status: "ignored", reason: "unknown_workspace" });
      expect(await events()).toEqual([]);
    });

    it("stores a body over 256 KB without its payload", async () => {
      await sendLinear(session("created", "s-7", { promptContext: "x".repeat(300 * 1024) }));
      expect(await onlyEvent()).toMatchObject({ payload: null, payloadTruncated: true });
    });
  });
});
