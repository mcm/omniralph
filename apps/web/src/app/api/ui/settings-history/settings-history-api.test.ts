// Change history per settings section: every tracked save path records one entry with the
// actor, the time and the changed fields only, publishes a `settings` change after it
// commits, and `GET /api/ui/settings-history` lists the entries with the runs started since.
import { randomBytes, randomUUID } from "node:crypto";
import {
  chatConnections,
  closeDb,
  connectRepository,
  createDb,
  getIntegration,
  harnesses,
  listSettingsChanges,
  organizationMembers,
  organizations,
  ralphRuns,
  reviewRuns,
  saveIntegration,
  settingsChanges,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { type RepositoryCodingInput, type RepositorySettingsInput } from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsHistorySchema, type SettingsHistory } from "@/lib/api/settings-history";
import { callAction } from "@/lib/api/test-call";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
// No Linear workspace for the Coding tab's checks.
vi.mock("@/lib/linear/settings-options", () => ({ getLinearSettingsOptions: async () => null }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const history = await import("./route");
const repositorySettings = await import("@/app/api/ui/repositories/[id]/settings/route");
const repositoryTaskTypes = await import("@/app/api/ui/repositories/[id]/task-types/route");
const repositoryCoding = await import("@/app/api/ui/repositories/[id]/coding/route");
const repository = await import("@/app/api/ui/repositories/[id]/route");
const routingRules = await import("@/app/api/ui/routing-rules/route");
const organization = await import("@/app/api/ui/organization/route");
const members = await import("@/app/api/ui/organization/members/[userId]/route");
const invitations = await import("@/app/api/ui/organization/invitations/route");
const domains = await import("@/app/api/ui/organization/domains/route");
const harnessDefaults = await import("@/app/api/ui/harness-defaults/route");
const discord = await import("@/app/api/ui/integrations/discord/[id]/route");
const { connectingWithHistory, settingsActor } = await import("@/lib/settings-history/sections");

const databaseAvailable = testDatabaseAvailable();

const person = (id: string, role: Role, name: string): TestUser => ({
  id,
  role,
  name,
  email: `${id}@acme.test`,
  image: null,
});
const admin = person("history-admin", "admin", "Ada Admin");
const member = person("history-member", "member", "Max Member");

const baseSettings: RepositorySettingsInput = {
  depth: "standard",
  triggers: { onOpen: true, onPush: true, drafts: false },
  pathExcludes: [],
  customInstructions: "",
  pinnedHarnessIds: [],
  reviewPlaybookIds: ["builtin:review-pr"],
  correlationPlaybookId: "builtin:correlate-findings",
};

const baseCoding: RepositoryCodingInput = {
  codingEnabled: true,
  codingInstructions: null,
  openPullRequestEarly: false,
  historyRewrite: "when-asked",
  respondToReviewsAndCi: true,
};

async function getHistory(query: Record<string, string>) {
  const url = new URL("http://localhost/api/ui/settings-history");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await history.GET(new Request(url), { params: Promise.resolve({}) });
  const body = (await response.json()) as SettingsHistory & { error?: string };
  return { status: response.status, body };
}

describe.skipIf(!databaseAvailable)("settings change history", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let connectionId: string;
  let repoId: string;
  let otherRepoId: string;
  let agentA: string;
  let agentB: string;
  let seq = 0;

  /** The section's (and subject's) entries, newest first, straight from the table. */
  const entries = async (section: string, subjectId: string | null = null) =>
    (await listSettingsChanges(db, { organizationIds: [orgId], section, subjectId, limit: 100 }))
      .entries;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    await db
      .insert(users)
      .values([admin, member].map(({ id, name, email }) => ({ id, name, email })));
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: admin.id, role: "admin" },
      { organizationId: orgId, userId: member.id, role: "member" },
    ]);
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "history-install",
      credentials: {},
    }))!;
    connectionId = connection.id;
    const repo = (fullPath: string) =>
      connectRepository(db, {
        connectionId,
        provider: "github",
        externalId: `ext-${++seq}`,
        fullPath,
        reviewsEnabled: true,
      });
    repoId = (await repo("acme/web")).id;
    otherRepoId = (await repo("acme/api")).id;
    [agentA, agentB] = (
      await db
        .insert(harnesses)
        .values([
          { organizationId: orgId, name: "coder-a" },
          { organizationId: orgId, name: "coder-b" },
        ])
        .returning({ id: harnesses.id })
    ).map((a) => a.id) as [string, string];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.user = admin;
    state.orgId = orgId;
  });

  describe("recording", () => {
    it("repository.reviews: records the changed fields once, with the actor", async () => {
      const save = (body: unknown) =>
        callAction(repositorySettings.PUT, "PUT", { id: repoId }, body);
      const { result, changes } = await captureChanges(() =>
        save({ ...baseSettings, triggers: { ...baseSettings.triggers, onPush: false } }),
      );
      expect(result).toEqual({ ok: true });
      const [entry] = await entries("repository.reviews", repoId);
      expect(entry).toMatchObject({
        actor: { userId: admin.id, name: "Ada Admin" },
        changes: [{ field: "onPush", label: "Review on push", before: "On", after: "Off" }],
      });
      expect(Date.now() - entry!.changedAt.getTime()).toBeLessThan(60_000);
      // Published once the save committed, with its section and subject.
      expect(changes).toContainEqual(
        expect.objectContaining({
          resource: "settings",
          section: "repository.reviews",
          subjectId: repoId,
          organizationId: orgId,
        }),
      );

      // The same values again: nothing recorded, nothing published for the history.
      await save({ ...baseSettings, triggers: { ...baseSettings.triggers, onPush: false } });
      expect(await entries("repository.reviews", repoId)).toHaveLength(1);

      // A refused save records nothing either.
      const refused = await captureChanges(() => save({ ...baseSettings, depth: "nope" }));
      expect(refused.result).toMatchObject({ ok: false });
      expect(refused.changes).toEqual([]);
      expect(await entries("repository.reviews", repoId)).toHaveLength(1);
    });

    it("task-type switches: the reviews switch in reviews, coding and ask in coding", async () => {
      expect(
        await callAction(
          repositoryTaskTypes.PUT,
          "PUT",
          { id: otherRepoId },
          { reviews: false, coding: false, ask: false },
        ),
      ).toEqual({ reviews: false, coding: false, ask: false });
      expect((await entries("repository.reviews", otherRepoId))[0]!.changes).toEqual([
        { field: "reviews", label: "Reviews", before: "On", after: "Off" },
      ]);
      expect((await entries("repository.coding", otherRepoId))[0]!.changes).toEqual([
        { field: "query", label: "Ask about code", before: "On", after: "Off" },
      ]);
      // Back on, as the other tests expect.
      await callAction(
        repositoryTaskTypes.PUT,
        "PUT",
        { id: otherRepoId },
        { reviews: true, coding: false, ask: true },
      );
    });

    it("repository.coding: the coding policy's changed settings", async () => {
      expect(
        await callAction(
          repositoryCoding.PUT,
          "PUT",
          { id: repoId },
          {
            ...baseCoding,
            codingEnabled: false,
            historyRewrite: "always",
            respondToReviewsAndCi: false,
          },
        ),
      ).toMatchObject({ historyRewrite: "always", respondToReviewsAndCi: false });
      expect((await entries("repository.coding", repoId))[0]!.changes).toEqual([
        {
          field: "historyRewrite",
          label: "Rewrite history",
          before: "When asked",
          after: "Always",
        },
        {
          field: "respondToReviewsAndCi",
          label: "Fix review comments and CI failures",
          before: "On",
          after: "Off",
        },
      ]);
    });

    it("repository.agents: pins from the repository's settings", async () => {
      expect(
        await callAction(
          repositorySettings.PUT,
          "PUT",
          { id: repoId },
          {
            ...baseSettings,
            triggers: { ...baseSettings.triggers, onPush: false },
            pinnedHarnessIds: [agentA],
          },
        ),
      ).toEqual({ ok: true });
      // Only the pins changed: no new review settings entry.
      expect(await entries("repository.reviews", repoId)).toHaveLength(1);
      expect((await entries("repository.agents", repoId))[0]!.changes).toEqual([
        { field: "agents", label: "Pinned agents", before: [], after: ["coder-a"] },
      ]);

      expect(
        await callAction(
          repositorySettings.PUT,
          "PUT",
          { id: repoId },
          {
            ...baseSettings,
            triggers: { ...baseSettings.triggers, onPush: false },
            pinnedHarnessIds: [agentA, agentB],
          },
        ),
      ).toEqual({ ok: true });
      expect((await entries("repository.agents", repoId))[0]!.changes).toEqual([
        {
          field: "agents",
          label: "Pinned agents",
          before: ["coder-a"],
          after: ["coder-a", "coder-b"],
        },
      ]);
      expect(await entries("repository.agents", otherRepoId)).toHaveLength(0);
    });

    it("routing_rules: describes each changed rule", async () => {
      const team = (key: string) => ({
        combinator: "and",
        rules: [{ field: "team", operator: "=", value: key }],
      });
      const put = (rules: unknown) => callAction(routingRules.PUT, "PUT", {}, { rules });
      expect(
        await put([
          { repositoryId: repoId, query: team("ENG") },
          { repositoryId: otherRepoId, query: team("OPS") },
        ]),
      ).toMatchObject({ ok: true });
      expect(
        await put([
          { repositoryId: repoId, query: team("ENG") },
          { repositoryId: repoId, query: team("OPS") },
        ]),
      ).toMatchObject({ ok: true });
      const [latest, first] = await entries("routing_rules");
      expect(first!.changes.map((c) => c.label)).toEqual(["Rule 1", "Rule 2"]);
      expect(latest!.changes).toEqual([
        {
          field: "rule.2",
          label: "Rule 2",
          before: "Team is OPS → acme/api",
          after: "Team is OPS → acme/web",
        },
      ]);
    });

    it("organization: name, member role, invitation and domain", async () => {
      expect(await callAction(organization.PATCH, "PATCH", {}, { name: "Acme Inc" })).toEqual({
        ok: true,
      });
      expect(
        await callAction(members.PATCH, "PATCH", { userId: member.id }, { role: "admin" }),
      ).toEqual({ ok: true });
      expect(
        await callAction(invitations.POST, "POST", {}, { email: "new@acme.test", role: "member" }),
      ).toEqual({ ok: true });
      expect(await callAction(domains.POST, "POST", {}, { domain: "acme.test" })).toEqual({
        ok: true,
      });
      const recorded = (await entries("organization")).map((e) => e.changes);
      expect(recorded.reverse()).toEqual([
        [{ field: "name", label: "Name", before: "Acme", after: "Acme Inc" }],
        [
          {
            field: `member:${member.id}|Role of Max Member`,
            label: "Role of Max Member",
            before: "member",
            after: "admin",
          },
        ],
        [
          {
            field: "invitation:new@acme.test|Invitation for new@acme.test",
            label: "Invitation for new@acme.test",
            before: null,
            after: "member",
          },
        ],
        [{ field: "domains", label: "Email domains", before: [], after: ["acme.test"] }],
      ]);
    });

    it("agent_defaults: concurrency", async () => {
      expect(
        await callAction(
          harnessDefaults.PUT,
          "PUT",
          {},
          {
            defaults: { maxConcurrency: 3 },
          },
        ),
      ).toEqual({ ok: true });
      const [entry] = await entries("agent_defaults");
      expect(entry!.changes).toEqual([
        { field: "maxConcurrency", label: "Max concurrency", before: 5, after: 3 },
      ]);
    });

    it("connection: a repository disconnected and a chat connection removed", async () => {
      const [repo] = await db
        .insert(chatConnections)
        .values({ organizationId: orgId, platform: "discord", externalId: "guild-1", name: "Acme" })
        .returning();
      const before = (await entries("connection", connectionId)).length;
      expect(await callAction(repository.DELETE, "DELETE", { id: otherRepoId })).toMatchObject({
        ok: true,
      });
      const [disconnect] = await entries("connection", connectionId);
      expect(await entries("connection", connectionId)).toHaveLength(before + 1);
      expect(disconnect!.changes).toEqual([
        {
          field: "repositories",
          label: "Reviewed repos",
          before: ["acme/api", "acme/web"],
          after: ["acme/web"],
        },
      ]);

      expect(await callAction(discord.DELETE, "DELETE", { id: repo!.id })).toMatchObject({
        ok: true,
      });
      const [removed] = await entries("connection", repo!.id);
      expect(removed!.changes).toEqual([
        { field: "connected", label: "Connected", before: "On", after: null },
        { field: "name", label: "Name", before: "Acme", after: null },
      ]);
    });

    it("connection: a connect records secrets as changed, and an identical one nothing", async () => {
      const connect = (token: string) =>
        connectingWithHistory(
          db,
          settingsActor(admin),
          orgId,
          null,
          (tx) =>
            saveIntegration(tx, {
              organizationId: orgId,
              provider: "linear",
              externalId: "workspace-1",
              name: "Acme Linear",
              credentials: { accessToken: token },
              installedByUserId: admin.id,
            }),
          (saved) => (saved === "other_organization" ? null : saved.id),
        );
      await connect("secret-token-1");
      const integration = (await getIntegration(db, orgId, "linear"))!;
      const [created] = await entries("connection", integration.id);
      expect(created!.changes).toEqual([
        { field: "connected", label: "Connected", before: null, after: "On" },
        { field: "name", label: "Name", before: null, after: "Acme Linear" },
        { field: "credentials", label: "Credentials", before: "changed", after: "changed" },
        { field: "ready", label: "Ready to start", before: null, after: ["unstarted"] },
        { field: "needsRefining", label: "Needs refining", before: null, after: ["backlog"] },
      ]);

      await connectingWithHistory(
        db,
        settingsActor(admin),
        orgId,
        integration.id,
        (tx) =>
          saveIntegration(tx, {
            organizationId: orgId,
            provider: "linear",
            externalId: "workspace-1",
            name: "Acme Linear",
            credentials: { accessToken: "secret-token-2" },
            installedByUserId: admin.id,
          }),
        (saved) => (saved === "other_organization" ? null : saved.id),
      );
      const [reconnected] = await entries("connection", integration.id);
      expect(reconnected!.changes).toEqual([
        { field: "credentials", label: "Credentials", before: "changed", after: "changed" },
      ]);
      const rows = await db
        .select()
        .from(settingsChanges)
        .where(eq(settingsChanges.subjectId, integration.id));
      expect(JSON.stringify(rows)).not.toContain("secret-token");
    });
  });

  describe("GET /api/ui/settings-history", () => {
    let subject: string;

    beforeAll(async () => {
      // A repository of its own, so the entries and runs are this test's only.
      const repo = await connectRepository(db, {
        connectionId,
        provider: "github",
        externalId: "history-only",
        fullPath: "acme/history",
        reviewsEnabled: true,
      });
      subject = repo.id;
      const at = (iso: string) => new Date(iso);
      await db.insert(settingsChanges).values(
        ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"].map((iso, i) => ({
          organizationId: orgId,
          section: "repository.reviews",
          subjectId: subject,
          actorUserId: admin.id,
          actorName: "Ada Admin",
          changedAt: at(iso),
          changes: [
            { field: "onPush", label: "Review on push", before: `v${i}`, after: `v${i + 1}` },
          ],
        })),
      );
      let n = 0;
      const review = (createdAt: string, repositoryId = subject) =>
        db.insert(reviewRuns).values({
          organizationId: orgId,
          repositoryId,
          prNumber: 1,
          headSha: `sha-${++n}`,
          baseSha: "base",
          trigger: "webhook",
          mode: "full",
          createdAt: at(createdAt),
        });
      await review("2026-09-30T00:00:00Z");
      await review("2026-10-01T12:00:00Z");
      await review("2026-10-02T12:00:00Z");
      await review("2026-10-03T12:00:00Z");
      await review("2026-10-04T12:00:00Z");
      // Neither another repository's review nor a coding run of this one counts.
      await review("2026-10-04T12:00:00Z", repoId);
      await db.insert(ralphRuns).values({
        organizationId: orgId,
        repositoryId: subject,
        kind: "children",
        linearIssueId: "issue-history",
        linearIdentifier: "ENG-1",
        linearAgentSessionId: "session-history",
        status: "completed",
        createdAt: at("2026-10-04T12:00:00Z"),
      });
    });

    it("lists entries newest first with the runs started since, and the latest", async () => {
      state.user = member;
      const { status, body } = await getHistory({ section: "repository.reviews", subject });
      expect(status).toBe(200);
      expect(settingsHistorySchema.parse(body)).toEqual(body);
      expect(body.entries.map((e) => [e.changedAt, e.runsSince])).toEqual([
        ["2026-10-03T00:00:00.000Z", 2],
        ["2026-10-02T00:00:00.000Z", 3],
        ["2026-10-01T00:00:00.000Z", 4],
      ]);
      expect(body.entries[0]).toEqual({
        id: expect.any(String),
        organization: { id: orgId, name: "Acme", role: "member" },
        section: "repository.reviews",
        subjectId: subject,
        actor: { id: admin.id, name: "Ada Admin" },
        changedAt: "2026-10-03T00:00:00.000Z",
        changes: [{ field: "onPush", label: "Review on push", before: "v2", after: "v3" }],
        runsSince: 2,
      });
      expect(body.latest).toEqual(body.entries[0]);
      expect(body.next).toBeNull();
    });

    it("pages with a cursor, keeping the latest entry on every page", async () => {
      const first = await getHistory({ section: "repository.reviews", subject, limit: "2" });
      expect(first.body.entries).toHaveLength(2);
      expect(first.body.next).toEqual(expect.any(String));
      const second = await getHistory({
        section: "repository.reviews",
        subject,
        limit: "2",
        cursor: first.body.next!,
      });
      expect(second.body.entries.map((e) => e.changedAt)).toEqual(["2026-10-01T00:00:00.000Z"]);
      expect(second.body.latest).toEqual(first.body.entries[0]);
      expect(second.body.next).toBeNull();
    });

    it("answers no latest for a section without history", async () => {
      const { body } = await getHistory({ section: "repository.coding", subject });
      expect(body).toEqual({ latest: null, entries: [], next: null });
    });

    it("counts organization-wide sections over every run of the organization", async () => {
      const { body } = await getHistory({ section: "agent_defaults" });
      expect(body.latest).toMatchObject({ subjectId: null, runsSince: expect.any(Number) });
    });

    it("refuses an unknown section, subject, cursor or limit, and a stranger's organization", async () => {
      expect((await getHistory({ section: "billing" })).status).toBe(400);
      expect((await getHistory({ section: "repository.reviews", subject: "x" })).status).toBe(400);
      expect(
        (await getHistory({ section: "repository.reviews", subject, cursor: "nope" })).status,
      ).toBe(400);
      expect((await getHistory({ section: "routing_rules", limit: "101" })).status).toBe(400);
      expect(
        (await getHistory({ section: "routing_rules", organization: otherOrgId })).status,
      ).toBe(404);
      expect(
        (await getHistory({ section: "routing_rules", organization: randomUUID() })).status,
      ).toBe(404);
    });

    it("requires a signed-in user", async () => {
      state.user = null;
      expect((await getHistory({ section: "routing_rules" })).status).toBe(401);
    });
  });
});
