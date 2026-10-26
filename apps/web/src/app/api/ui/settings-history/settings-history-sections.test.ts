// Change history of the connection section's save paths that call a code host, tracker or
// chat platform (stubbed here): each save records one entry with the actor and the changed
// fields only, and an identical save records nothing. Then "runs since" per section, with
// runs seeded before and after a change.
import { randomBytes } from "node:crypto";
import {
  chatThreadRuns,
  closeDb,
  connectRepository,
  createDb,
  ensureChatThread,
  getIntegration,
  insertJob,
  listConnectionRepositories,
  listSettingsChanges,
  mapThreadRun,
  organizationMembers,
  organizations,
  playbooks,
  ralphRuns,
  reviewRuns,
  saveChatConnection,
  saveIntegration,
  settingsChanges,
  triageRuns,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { getBuiltinPlaybook } from "@omniralph/tasks";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsHistory } from "@/lib/api/settings-history";
import { callAction } from "@/lib/api/test-call";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
  /** The GitHub installation's repositories. */
  githubRepos: [] as { id: number; fullPath: string }[],
  /** The projects the GitLab bot maintains. */
  gitlabProjects: [] as { id: number; fullPath: string; webUrl: string; visibility: string }[],
  nextHookId: 9000,
  deletedHooks: [] as number[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
// The code hosts, Linear, Slack and Discord: never called in tests.
vi.mock("@omniralph/scm", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listInstallationRepos: async () => state.githubRepos,
  GitLabSetupClient: class {
    readonly baseUrl: string;
    constructor(options: { baseUrl: string }) {
      this.baseUrl = options.baseUrl;
    }
    async validateToken() {
      return { userId: 77, username: "omniralph_bot", name: "Omniralph" };
    }
    async listProjects() {
      return state.gitlabProjects;
    }
    async createProjectHook() {
      return state.nextHookId++;
    }
    async deleteProjectHook(_projectId: number, hookId: number) {
      state.deletedHooks.push(hookId);
    }
  },
}));
vi.mock("@/lib/scm/github-app", () => ({ getGitHubAppAuth: () => ({}) }));
vi.mock("@/lib/scm/adapters", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scmAdapterFor: () => ({
    getReadOnlyCloneCredential: async () => ({ username: "oauth2", password: "clone-token" }),
  }),
}));
vi.mock("@/lib/linear/oauth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revokeToken: async () => {},
}));
vi.mock("@/lib/chat/slack-oauth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revokeSlackToken: async () => {},
}));
vi.mock("@/lib/chat/discord-oauth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discordOAuthConfig: () => null,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";

const history = await import("./route");
const gitlabConnections = await import("@/app/api/ui/gitlab-connections/route");
const selection = await import("@/app/api/ui/scm-connections/[id]/repositories/route");
const repositoryWebhook = await import("@/app/api/ui/repositories/[id]/webhook/route");
const chatPlaybooks = await import("@/app/api/ui/integrations/chat-tasks/route");
const channelPlaybooks =
  await import("@/app/api/ui/integrations/chat-connections/[id]/channels/route");
const linear = await import("@/app/api/ui/integrations/linear/route");
const slack = await import("@/app/api/ui/integrations/slack/[id]/route");
const discord = await import("@/app/api/ui/integrations/discord/[id]/route");

const databaseAvailable = testDatabaseAvailable();

const admin: TestUser = {
  id: "sections-admin",
  role: "admin",
  name: "Ada Admin",
  email: "ada@acme.test",
  image: null,
};
const GITLAB = "https://gitlab.example.com";

describe.skipIf(!databaseAvailable)("settings change history of connections", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let runsOrgId: string;
  let otherOrgId: string;

  /** The section's (and subject's) entries, newest first. */
  const entries = async (section: string, subjectId: string | null, organizationId = orgId) =>
    (
      await listSettingsChanges(db, {
        organizationIds: [organizationId],
        section,
        subjectId,
        limit: 100,
      })
    ).entries;

  /** Runs `save`, expecting it to succeed and record exactly one entry for the subject. */
  async function recordsOne(subjectId: string | null, save: () => Promise<unknown>) {
    const before = await entries("connection", subjectId);
    expect(await save()).toMatchObject({ ok: true });
    const after = await entries("connection", subjectId);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]!.actor).toEqual({ userId: admin.id, name: "Ada Admin" });
    expect(Date.now() - after[0]!.changedAt.getTime()).toBeLessThan(60_000);
    return after[0]!.changes;
  }

  /** Runs `save`, expecting it to succeed and record nothing for the subject. */
  async function recordsNothing(subjectId: string | null, save: () => Promise<unknown>) {
    const before = await entries("connection", subjectId);
    expect(await save()).toMatchObject({ ok: true });
    expect(await entries("connection", subjectId)).toHaveLength(before.length);
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const created = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Runs" }, { name: "Other" }])
      .returning();
    [orgId, runsOrgId, otherOrgId] = created.map((o) => o.id) as [string, string, string];
    await db.insert(users).values({ id: admin.id, name: admin.name, email: admin.email });
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: admin.id, role: "admin" },
      { organizationId: runsOrgId, userId: admin.id, role: "admin" },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.user = admin;
    state.orgId = orgId;
  });

  describe("connection saves", () => {
    it("GitLab connect, project selection and webhook recreate", async () => {
      const connect = () =>
        callAction(gitlabConnections.POST, "POST", {}, { baseUrl: GITLAB, token: "glpat-bot" });
      const connected = await connect();
      expect(connected).toMatchObject({ ok: true, connectionId: expect.any(String) });
      const connectionId = (connected as unknown as { connectionId: string }).connectionId;
      const [created] = await entries("connection", connectionId);
      expect(created).toMatchObject({ actor: { userId: admin.id, name: "Ada Admin" } });
      expect(created!.changes).toEqual([
        { field: "connected", label: "Connected", before: null, after: "On" },
        {
          field: "name",
          label: "Name",
          before: null,
          after: "omniralph_bot @ gitlab.example.com",
        },
        { field: "url", label: "URL", before: null, after: GITLAB },
        { field: "credentials", label: "Credentials", before: "changed", after: "changed" },
        { field: "repositories", label: "Reviewed repos", before: null, after: [] },
      ]);
      // Connecting again with the same token (the webhook secret is kept): nothing changed.
      await recordsNothing(connectionId, connect);
      expect(await entries("connection", connectionId)).toHaveLength(1);

      // Selecting projects: the reviewed repos and the new project's webhook.
      state.gitlabProjects = [
        { id: 101, fullPath: "acme/api", webUrl: `${GITLAB}/acme/api`, visibility: "private" },
        { id: 102, fullPath: "acme/web", webUrl: `${GITLAB}/acme/web`, visibility: "private" },
      ];
      const select = (selectedIds: number[]) => () =>
        callAction(selection.PUT, "PUT", { id: connectionId }, { provider: "gitlab", selectedIds });
      const firstHook = state.nextHookId;
      const selected = await recordsOne(connectionId, select([101]));
      const [api] = (await listConnectionRepositories(db, connectionId)).filter(
        (r) => r.fullPath === "acme/api",
      );
      expect(selected).toEqual([
        { field: "repositories", label: "Reviewed repos", before: [], after: ["acme/api"] },
        {
          field: `webhook:${api!.id}|Webhook of acme/api`,
          label: "Webhook of acme/api",
          before: null,
          after: `ID ${firstHook}`,
        },
      ]);
      await recordsNothing(connectionId, select([101]));

      // Recreating the project's webhook: only its ID changed.
      const recreated = await recordsOne(connectionId, () =>
        callAction(repositoryWebhook.POST, "POST", { id: api!.id }),
      );
      expect(state.deletedHooks).toContain(firstHook);
      expect(recreated).toEqual([
        {
          field: `webhook:${api!.id}|Webhook of acme/api`,
          label: "Webhook of acme/api",
          before: `ID ${firstHook}`,
          after: `ID ${firstHook + 1}`,
        },
      ]);
    });

    it("GitHub repository selection", async () => {
      const connection = (await upsertScmConnection(db, {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "4242",
        credentials: {},
      }))!;
      state.githubRepos = [
        { id: 1, fullPath: "acme/one" },
        { id: 2, fullPath: "acme/two" },
      ];
      const select = (selectedIds: number[]) => () =>
        callAction(
          selection.PUT,
          "PUT",
          { id: connection.id },
          { provider: "github", selectedIds },
        );
      expect(await recordsOne(connection.id, select([1, 2]))).toEqual([
        {
          field: "repositories",
          label: "Reviewed repos",
          before: [],
          after: ["acme/one", "acme/two"],
        },
      ]);
      expect(await recordsOne(connection.id, select([2]))).toEqual([
        {
          field: "repositories",
          label: "Reviewed repos",
          before: ["acme/one", "acme/two"],
          after: ["acme/two"],
        },
      ]);
      await recordsNothing(connection.id, select([2]));
    });

    it("Slack and Discord settings: the organization's chat playbooks and a channel's", async () => {
      // The organization's own "ask about code" playbook.
      const { id: _id, name, role, ...definition } = getBuiltinPlaybook("builtin:ask-about-code")!;
      const [custom] = await db
        .insert(playbooks)
        .values({
          organizationId: orgId,
          name: `Custom ${name}`,
          role,
          definition,
          requirements: { minAgentVersion: "0.40.0", installables: [], hostTools: ["git"] },
        })
        .returning();
      const save = () =>
        callAction(
          chatPlaybooks.PUT,
          "PUT",
          {},
          { ask: custom!.id, startWork: "builtin:handle-request" },
        );
      expect(await recordsOne(null, save)).toEqual([
        {
          field: "ask",
          label: "Ask about code playbook",
          before: name,
          after: `Custom ${name}`,
        },
      ]);
      await recordsNothing(null, save);

      const connection = await saveChatConnection(db, {
        organizationId: orgId,
        platform: "slack",
        externalId: "T-SECTIONS",
        name: "Acme Slack",
        credentials: { botToken: "xoxb-1" },
        installedByUserId: admin.id,
      });
      if (connection === "other_organization") throw new Error("setup");
      const field = "channel:slack:C0123ABCD|Playbooks of channel C0123ABCD";
      const channel = () =>
        callAction(
          channelPlaybooks.PUT,
          "PUT",
          { id: connection.id },
          { channel: "C0123ABCD", ask: custom!.id, startWork: null },
        );
      expect(await recordsOne(connection.id, channel)).toEqual([
        {
          field,
          label: "Playbooks of channel C0123ABCD",
          before: null,
          after: `Ask about code: Custom ${name}`,
        },
      ]);
      await recordsNothing(connection.id, channel);
      expect(
        await recordsOne(connection.id, () =>
          callAction(
            channelPlaybooks.DELETE,
            "DELETE",
            { id: connection.id },
            { channelId: "slack:C0123ABCD" },
          ),
        ),
      ).toEqual([
        {
          field,
          label: "Playbooks of channel C0123ABCD",
          before: `Ask about code: Custom ${name}`,
          after: null,
        },
      ]);
    });

    it("Linear, Slack and Discord disconnects", async () => {
      await saveIntegration(db, {
        organizationId: orgId,
        provider: "linear",
        externalId: "workspace-sections",
        name: "Acme Linear",
        credentials: { accessToken: "lin-token" },
        installedByUserId: admin.id,
      });
      const integration = (await getIntegration(db, orgId, "linear"))!;
      expect(
        await recordsOne(integration.id, () => callAction(linear.DELETE, "DELETE", {})),
      ).toEqual([
        { field: "connected", label: "Connected", before: "On", after: null },
        { field: "name", label: "Name", before: "Acme Linear", after: null },
        { field: "credentials", label: "Credentials", before: "changed", after: "changed" },
        { field: "ready", label: "Ready to start", before: ["unstarted"], after: null },
        { field: "needsRefining", label: "Needs refining", before: ["backlog"], after: null },
      ]);

      for (const platform of ["slack", "discord"] as const) {
        const connection = await saveChatConnection(db, {
          organizationId: orgId,
          platform,
          externalId: `${platform}-disconnect`,
          name: `Acme ${platform}`,
          credentials: platform === "slack" ? { botToken: "xoxb-2" } : null,
          installedByUserId: admin.id,
        });
        if (connection === "other_organization") throw new Error("setup");
        const route = platform === "slack" ? slack : discord;
        expect(
          await recordsOne(connection.id, () =>
            callAction(route.DELETE, "DELETE", { id: connection.id }),
          ),
        ).toEqual([
          { field: "connected", label: "Connected", before: "On", after: null },
          { field: "name", label: "Name", before: `Acme ${platform}`, after: null },
          ...(platform === "slack"
            ? [{ field: "credentials", label: "Credentials", before: "changed", after: "changed" }]
            : []),
        ]);
      }
    });
  });

  describe("runs since, per section", () => {
    const CHANGED_AT = new Date("2026-10-10T00:00:00Z");
    const BEFORE = new Date("2026-10-05T00:00:00Z");
    const AFTER = new Date("2026-10-15T00:00:00Z");
    let repoId: string;
    let otherRepoId: string;
    let scmConnectionId: string;
    let chatConnectionId: string;
    let integrationId: string;
    let n = 0;

    beforeAll(async () => {
      const scm = (await upsertScmConnection(db, {
        organizationId: runsOrgId,
        provider: "github",
        name: "runs",
        baseUrl: "https://api.github.com",
        externalId: "runs-install",
        credentials: {},
      }))!;
      scmConnectionId = scm.id;
      const repo = (fullPath: string) =>
        connectRepository(db, {
          connectionId: scm.id,
          provider: "github",
          externalId: `runs-${fullPath}`,
          fullPath,
          reviewsEnabled: true,
        });
      repoId = (await repo("runs/web")).id;
      otherRepoId = (await repo("runs/api")).id;
      await saveIntegration(db, {
        organizationId: runsOrgId,
        provider: "linear",
        externalId: "runs-workspace",
        name: "Runs Linear",
        credentials: { accessToken: "token" },
        installedByUserId: admin.id,
      });
      integrationId = (await getIntegration(db, runsOrgId, "linear"))!.id;
      const chat = await saveChatConnection(db, {
        organizationId: runsOrgId,
        platform: "slack",
        externalId: "T-RUNS",
        name: "Runs Slack",
        credentials: null,
        installedByUserId: null,
      });
      if (chat === "other_organization") throw new Error("setup");
      chatConnectionId = chat.id;

      const ralph = (
        createdAt: Date,
        values: { mode?: "epic" | "request"; repositoryId?: string | null } = {},
        organizationId = runsOrgId,
      ) =>
        db.insert(ralphRuns).values({
          organizationId,
          repositoryId: values.repositoryId === undefined ? repoId : values.repositoryId,
          kind: values.mode === "request" ? "single" : "children",
          mode: values.mode ?? "epic",
          linearIssueId: `runs-issue-${++n}`,
          linearIdentifier: `RUN-${n}`,
          linearAgentSessionId: `runs-session-${n}`,
          status: "completed",
          createdAt,
        });
      const review = (createdAt: Date, repositoryId = repoId) =>
        db.insert(reviewRuns).values({
          organizationId: runsOrgId,
          repositoryId,
          prNumber: 1,
          headSha: `runs-sha-${++n}`,
          baseSha: "base",
          trigger: "webhook",
          mode: "full",
          createdAt,
        });
      const triage = (createdAt: Date) =>
        db.insert(triageRuns).values({
          organizationId: runsOrgId,
          linearIssueId: `runs-triage-${++n}`,
          linearAgentSessionId: `runs-triage-session-${n}`,
          trigger: "mention",
          status: "completed",
          createdAt,
        });
      const thread = async () =>
        (await ensureChatThread(db, {
          connectionId: chatConnectionId,
          externalThreadId: `slack:C0RUNS:${++n}.1`,
          channelId: "slack:C0RUNS",
          startedByExternalUserId: "U1",
        }))!;
      const ask = async (createdAt: Date) => {
        const { job } = await insertJob(db, {
          organizationId: runsOrgId,
          type: "chat.ask",
          taskType: "query",
          repositoryId: repoId,
        });
        const run = (await mapThreadRun(db, {
          organizationId: runsOrgId,
          chatThreadId: (await thread()).id,
          jobId: job.id,
        }))!;
        await db.update(chatThreadRuns).set({ createdAt }).where(eq(chatThreadRuns.id, run.id));
      };

      // Before the change: one of each kind (none of them counts).
      await ralph(BEFORE);
      await ralph(BEFORE, { mode: "request" });
      await review(BEFORE);
      await triage(BEFORE);
      await ask(BEFORE);
      // After it.
      await ralph(AFTER); // epic of the repo, from Linear
      await ralph(AFTER, { mode: "request" }); // request of the repo, a Linear mention
      await ralph(AFTER, { repositoryId: otherRepoId }); // epic of the other repo
      await db.insert(ralphRuns).values({
        organizationId: runsOrgId,
        repositoryId: repoId,
        origin: "chat",
        chatThreadId: (await thread()).id,
        kind: "single",
        mode: "request",
        status: "completed",
        createdAt: AFTER,
      }); // request of the repo, from chat
      await review(AFTER); // review of the repo
      await review(AFTER, otherRepoId); // review of the other repo
      await triage(AFTER); // triage, no repo
      await ask(AFTER); // ask about the repo, from chat
      // Another organization's run never counts.
      await ralph(AFTER, { repositoryId: null }, otherOrgId);

      const change = (section: string, subjectId: string | null) => ({
        organizationId: runsOrgId,
        section,
        subjectId,
        actorUserId: admin.id,
        actorName: "Ada Admin",
        changedAt: CHANGED_AT,
        changes: [{ field: "x", label: "X", before: "a", after: "b" }],
      });
      await db
        .insert(settingsChanges)
        .values([
          change("repository.reviews", repoId),
          change("repository.coding", repoId),
          change("repository.agents", repoId),
          change("routing_rules", null),
          change("connection", scmConnectionId),
          change("connection", integrationId),
          change("connection", chatConnectionId),
          change("connection", null),
          change("organization", null),
          change("agent_defaults", null),
        ]);
    });

    beforeEach(() => {
      state.orgId = runsOrgId;
    });

    async function runsSince(section: string, subject?: string) {
      const url = new URL("http://localhost/api/ui/settings-history");
      url.searchParams.set("section", section);
      if (subject) url.searchParams.set("subject", subject);
      const response = await history.GET(new Request(url), { params: Promise.resolve({}) });
      expect(response.status).toBe(200);
      const body = (await response.json()) as SettingsHistory;
      expect(body.entries).toHaveLength(1);
      expect(body.latest!.changedAt).toBe(CHANGED_AT.toISOString());
      return body.latest!.runsSince;
    }

    it("repository.reviews: the repository's reviews", async () => {
      expect(await runsSince("repository.reviews", repoId)).toBe(1);
    });

    it("repository.coding: the repository's epics and requests (Linear and chat)", async () => {
      expect(await runsSince("repository.coding", repoId)).toBe(3);
    });

    it("repository.agents: every run of the repository", async () => {
      // Epic, Linear request, chat request, review and ask.
      expect(await runsSince("repository.agents", repoId)).toBe(5);
    });

    it("routing_rules: the organization's epics, requests and triage", async () => {
      expect(await runsSince("routing_rules")).toBe(5);
    });

    it("connection: the runs whose trigger came through it", async () => {
      // The code host's reviews, of both its repositories.
      expect(await runsSince("connection", scmConnectionId)).toBe(2);
      // Linear: the epics, the mention and the triage run.
      expect(await runsSince("connection", integrationId)).toBe(4);
      // Slack: the ask and the chat request.
      expect(await runsSince("connection", chatConnectionId)).toBe(2);
      // The organization's chat playbooks: every run chat started.
      expect(await runsSince("connection")).toBe(2);
    });

    it("organization and agent_defaults: every run of the organization", async () => {
      expect(await runsSince("organization")).toBe(8);
      expect(await runsSince("agent_defaults")).toBe(8);
    });

    it("counts nothing when no run started since", async () => {
      await db
        .update(settingsChanges)
        .set({ changedAt: new Date("2026-10-20T00:00:00Z") })
        .where(
          and(
            eq(settingsChanges.organizationId, runsOrgId),
            eq(settingsChanges.section, "organization"),
          ),
        );
      const url = new URL("http://localhost/api/ui/settings-history?section=organization");
      const response = await history.GET(new Request(url), { params: Promise.resolve({}) });
      expect(((await response.json()) as SettingsHistory).latest!.runsSince).toBe(0);
    });
  });
});
