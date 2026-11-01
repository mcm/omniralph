/**
 * Linear webhook deliveries that start ralph runs, end to end: the webhook
 * acknowledges and hands the parsed event to the ralph orchestrator.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  chatLinearDelegations,
  closeDb,
  connectRepository,
  createChatLinearDelegation,
  createDb,
  ensureChatThread,
  getRunBySession,
  integrations,
  jobs,
  organizations,
  ralphRuns,
  replaceRoutingRules,
  saveChatConnection,
  saveIntegration,
  upsertScmConnection,
  webhookDeliveries,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { ScmAdapter } from "@omniralph/scm";
import type { RoutingQuery } from "@omniralph/shared";
import type { TrackerEvent } from "@omniralph/tracker";
import { AGENT_SESSION_MARKER, signBody } from "@omniralph/tracker/linear";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { ACKNOWLEDGEMENT, startRun, type StartRunDeps } from "@/lib/ralph/start";
import { acknowledgeTrackerEvent, handleTrackerEvent } from "@/lib/tracker/events";
import { handleLinearWebhook } from "./ingest";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const labels = (...values: string[]): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "labels", operator: "containsAny", value: values }],
});
const team = (key: string): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "team", operator: "=", value: key }],
});

const DELEGATION = `${AGENT_SESSION_MARKER}. Delegated by Steve.`;

describe.skipIf(!testDatabaseAvailable())("starting ralph runs through the Linear webhook", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
  let linear: FakeLinearGateway;

  const fakeAdapter = {
    getDefaultBranch: async () => "develop",
  } as unknown as ScmAdapter;

  const deps = (): StartRunDeps => ({
    db,
    organizationId: orgId,
    linear,
    dispatcher: new PostgresDispatcher({ db }),
    adapterFor: () => fakeAdapter,
  });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
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
    otherRepoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    await setCodingEnabled(db, repoId);
    await setCodingEnabled(db, otherRepoId);
    const saved = await replaceRoutingRules(db, orgId, [
      { repositoryId: otherRepoId, query: labels("frontend") },
      { repositoryId: repoId, query: team("ENG") },
    ]);
    expect(saved.ok).toBe(true);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    linear = new FakeLinearGateway();
  });

  const SECRET = "linear-secret";

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(integrations);
    await saveIntegration(db, {
      organizationId: orgId,
      provider: "linear",
      externalId: "org-1",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
  });

  it("acknowledges before responding, starts the run after, and dedupes redeliveries", async () => {
    const issue = linear.add({ identifier: "ENG-100", title: "Hooked" });
    const deferred: Array<() => Promise<void>> = [];
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-hook",
        issue: { id: issue.id, identifier: "ENG-100" },
        comment: { body: DELEGATION },
      },
    };
    const deliver = (deliveryId: string) => {
      const body = JSON.stringify(payload);
      return handleLinearWebhook(
        new Request("https://omniralph.example.com/api/webhooks/linear", {
          method: "POST",
          headers: { "linear-signature": signBody(body, SECRET), "linear-delivery": deliveryId },
          body,
        }),
        {
          db,
          secret: SECRET,
          acknowledge: (event, context) => acknowledgeTrackerEvent(event, context, linear),
          handle: async (event: Exclude<TrackerEvent, { kind: "ignored" }>) => {
            if (event.kind === "issue_delegated") await startRun(event, deps());
          },
          defer: (task) => {
            deferred.push(task);
          },
        },
      );
    };

    const id = randomUUID();
    expect(await (await deliver(id)).json()).toEqual({
      status: "accepted",
      kind: "issue_delegated",
    });
    // Only the acknowledgement so far.
    expect(linear.activities).toEqual([
      {
        sessionId: "session-hook",
        content: { type: "thought", body: ACKNOWLEDGEMENT },
        options: { ephemeral: true },
      },
    ]);
    expect(await db.select().from(ralphRuns)).toEqual([]);

    expect(await (await deliver(id)).json()).toEqual({ status: "duplicate" });
    for (const task of deferred.splice(0)) await task();

    expect(await db.select().from(ralphRuns)).toHaveLength(1);
    expect(linear.bodies("session-hook", "thought")).toHaveLength(3);
    expect(linear.plan("session-hook")).toEqual([
      { content: "ENG-100: Hooked", status: "inProgress" },
    ]);
  });

  it("ties the run of an issue delegated from chat to the thread, keeping its Linear origin", async () => {
    const connection = await saveChatConnection(db, {
      organizationId: orgId,
      platform: "discord",
      externalId: "G-webhook",
      name: "Acme",
      credentials: null,
      installedByUserId: null,
    });
    if (connection === "other_organization") throw new Error("connected elsewhere");
    const thread = (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: "discord:G-webhook:CH1:TH1",
      channelId: "discord:G-webhook:CH1",
      startedByExternalUserId: "D-ADA",
    }))!;
    const issue = linear.add({ identifier: "ENG-110", title: "From chat" });
    await createChatLinearDelegation(db, {
      organizationId: orgId,
      threadId: thread.id,
      linearIssueId: issue.id,
    });
    const adapter = createMockAdapter("discord");
    const chat = {
      db,
      adapters: { discord: adapter },
      state: createMockState(),
      appUrl: "https://omniralph.example.com",
    };
    const body = JSON.stringify({
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-from-chat",
        issue: { id: issue.id, identifier: "ENG-110" },
        comment: { body: DELEGATION },
      },
    });
    await handleLinearWebhook(
      new Request("https://omniralph.example.com/api/webhooks/linear", {
        method: "POST",
        headers: { "linear-signature": signBody(body, SECRET), "linear-delivery": randomUUID() },
        body,
      }),
      {
        db,
        secret: SECRET,
        handle: (event, context) =>
          handleTrackerEvent(event, context, {
            linear,
            dispatcher: new PostgresDispatcher({ db }),
            adapterFor: () => fakeAdapter,
            chat,
          }),
      },
    );

    expect(await getRunBySession(db, "session-from-chat")).toMatchObject({
      origin: "linear",
      linearIssueId: issue.id,
      chatThreadId: thread.id,
      status: "running",
    });
    expect(await db.select().from(chatLinearDelegations)).toEqual([]);
    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledWith("discord:G-webhook:CH1:TH1", {
      markdown: expect.stringContaining("🚀 Omniralph started building [ENG-110 From chat]"),
    });
  });

  it("routes only to repositories of the organization that connected the workspace", async () => {
    // Another organization, with its own workspace and a repository matching team OPS.
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    const otherConnection = (await upsertScmConnection(
      db,
      {
        organizationId: other!.id,
        provider: "github",
        name: "other",
        baseUrl: "https://api.github.com",
        externalId: "other-installation",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const foreignRepoId = (
      await connectRepository(db, {
        connectionId: otherConnection.id,
        provider: "github",
        externalId: "99",
        fullPath: "other/ops",
      })
    ).id;
    await setCodingEnabled(db, foreignRepoId);
    await replaceRoutingRules(db, other!.id, [{ repositoryId: foreignRepoId, query: team("OPS") }]);
    await saveIntegration(db, {
      organizationId: other!.id,
      provider: "linear",
      externalId: "org-2",
      name: "Other",
      credentials: { accessToken: "t2" },
      installedByUserId: null,
    });

    const deliver = (workspaceId: string, sessionId: string, issue: { id: string }) => {
      const body = JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        organizationId: workspaceId,
        webhookTimestamp: Date.now(),
        agentSession: {
          id: sessionId,
          issue: { id: issue.id, identifier: "OPS-1" },
          comment: { body: DELEGATION },
        },
      });
      return handleLinearWebhook(
        new Request("https://omniralph.example.com/api/webhooks/linear", {
          method: "POST",
          headers: { "linear-signature": signBody(body, SECRET), "linear-delivery": sessionId },
          body,
        }),
        {
          db,
          secret: SECRET,
          handle: (event, context) =>
            handleTrackerEvent(event, context, {
              linear,
              dispatcher: new PostgresDispatcher({ db }),
              adapterFor: () => fakeAdapter,
            }),
        },
      );
    };

    // From our workspace: team OPS matches only the other organization's repository,
    // which is ignored, so a person is asked to pick one of ours.
    const ours = linear.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
    await deliver("org-1", "session-ours", ours);
    const run = await getRunBySession(db, "session-ours");
    expect(run).toMatchObject({ organizationId: orgId, repositoryId: null, status: "waiting" });
    expect(run!.pendingElicitation).toMatchObject({ kind: "repository" });
    const offered = (run!.pendingElicitation as { repositoryIds: string[] }).repositoryIds;
    expect(offered.sort()).toEqual([repoId, otherRepoId].sort());
    expect(linear.bodies("session-ours", "elicitation").join("\n")).not.toContain("other/ops");

    // From the other organization's workspace, the same team routes to its repository.
    const theirs = linear.add({ identifier: "OPS-2", title: "Infra", teamKey: "OPS" });
    await deliver("org-2", "session-theirs", theirs);
    expect(await getRunBySession(db, "session-theirs")).toMatchObject({
      organizationId: other!.id,
      repositoryId: foreignRepoId,
      routedBy: "rule 1 (Team is OPS)",
    });
  });
});
