import { randomBytes } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  connectRepository,
  closeDb,
  createDb,
  createRun,
  ensureChatThread,
  getRun,
  jobs,
  organizations,
  ralphRuns,
  runMigrations,
  saveChatConnection,
  seedReviewProfiles,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  type ChatConnection,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Adapter } from "chat";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelQueuesDispatcher, type JobDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import type { ChatChannel } from "./conversation";
import { RECONCILE_STALE_MS } from "./reconcile";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { startChatRequest } = await import("./chat-start");
const { reconcileAllOrganizations } = await import("./reconcile-cron");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const THREAD_ID = "discord:G1:CH1:TH1";

/**
 * The reconcile cron and chat runs of an organization without Linear: they
 * are reconciled (with a disconnected Linear gateway); its Linear runs aren't.
 */
describe.skipIf(!dockerAvailable)("reconcile cron, organization without Linear", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let connection: ChatConnection;
  let chatThread: ChatThread;
  let scm: FakeScmAdapter;
  let dispatcher: VercelQueuesDispatcher;
  let adapter: Adapter;
  let state: ReturnType<typeof createMockState>;

  const chat = (): ChatChannel => ({
    db,
    adapters: { discord: adapter },
    state,
    appUrl: "https://omniralph.example.com",
    encryptionKey: key,
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await seedReviewProfiles(db, orgId);
    const scmConnection = (await upsertScmConnection(
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
    const repoId = (
      await connectRepository(db, {
        connectionId: scmConnection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/app",
      })
    ).id;
    await updateRepositoryRalphSettings(db, repoId, {
      ralphEnabled: true,
      linearTeamKeys: [],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    const saved = await saveChatConnection(
      db,
      {
        organizationId: orgId,
        platform: "discord",
        externalId: "G1",
        name: "Acme server",
        credentials: null,
        installedByUserId: null,
      },
      key,
    );
    if (saved === "other_organization") throw new Error("taken");
    connection = saved;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.execute("DELETE FROM chat_threads");
    chatThread = (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: THREAD_ID,
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D1",
    }))!;
    scm = new FakeScmAdapter();
    dispatcher = new VercelQueuesDispatcher({ db, publisher: new RecordingPublisher() });
    let n = 0;
    adapter = createMockAdapter("discord", {
      postMessage: vi.fn(async (threadId: string) => {
        n += 1;
        return { id: `m-${n}`, threadId, raw: {} };
      }),
    });
    state = createMockState();
  });

  const cronDeps = () => ({ db, dispatcher, adapterFor: () => scm.asAdapter(), chat: chat() });
  const later = () => new Date(Date.now() + RECONCILE_STALE_MS + 60_000);
  const jobsOf = (runId: string) => db.select().from(jobs).where(eq(jobs.ralphRunId, runId));

  it("enqueues the pending request of a chat run whose first advance failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: JobDispatcher = {
      createAndPublish: async () => {
        throw new Error("queue down");
      },
      cancel: async () => {
        throw new Error("queue down");
      },
      republish: async () => false,
    };
    const started = await startChatRequest(
      {
        db,
        organizationId: orgId,
        linear: new Proxy({} as never, {
          get: () => {
            throw new Error("Linear used");
          },
        }),
        dispatcher: failing,
        adapterFor: () => scm.asAdapter(),
        chat: chat(),
      },
      {
        chatThreadId: chatThread.id,
        repository: "acme/app",
        request: "Fix the typo in the README.",
        quoted: [],
        author: "Ada",
        announce: async () => {},
      },
    );
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    expect(await jobsOf(started.run.id)).toEqual([]);

    // Not stale yet: left alone.
    expect(await reconcileAllOrganizations(cronDeps())).toMatchObject({
      organizations: 1,
      reconciled: 0,
      failed: 0,
    });
    expect(await jobsOf(started.run.id)).toEqual([]);

    expect(await reconcileAllOrganizations(cronDeps(), later())).toMatchObject({
      organizations: 1,
      reconciled: 1,
      failed: 0,
    });
    const enqueued = await jobsOf(started.run.id);
    expect(enqueued.map((j) => [j.type, j.status])).toEqual([["ralph.request", "queued"]]);
    expect((await getRun(db, started.run.id))?.requestJobId).toBe(enqueued[0]!.id);
  });

  it("leaves the organization's Linear runs alone", async () => {
    await createRun(db, {
      origin: "chat",
      organizationId: orgId,
      chatThreadId: chatThread.id,
      repositoryId: null,
      status: "completed",
    });
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: "issue-1",
      linearIdentifier: "ENG-1",
      linearAgentSessionId: "session-1",
      kind: "single",
      mode: "request",
      repositoryId: null,
    });
    await db
      .update(ralphRuns)
      .set({ status: "waiting", updatedAt: new Date(0) })
      .where(eq(ralphRuns.id, run.id));
    expect(await reconcileAllOrganizations(cronDeps(), later())).toMatchObject({
      organizations: 1,
      reconciled: 0,
      failed: 0,
    });
    expect(await getRun(db, run.id)).toMatchObject({ status: "waiting" });
  });
});
