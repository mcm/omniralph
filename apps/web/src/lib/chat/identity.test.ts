import { randomBytes } from "node:crypto";
import {
  chatIdentities,
  chatIdentityOptOuts,
  chatUserProfiles,
  closeDb,
  createDb,
  getChatIdentity,
  hasChatIdentityOptOut,
  listChatIdentities,
  organizationMembers,
  organizations,
  saveChatConnection,
  setOrganizationDomains,
  unlinkChatIdentity,
  users,
  type ChatConnection,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackCredentials } from "./slack-oauth";

vi.mock("server-only", () => ({}));

const { CHAT_PROFILE_TTL_MS, fetchSlackUser, resolveChatActor } = await import("./identity");
const { CHAT_LINK_TTL_SECONDS, createLinkUrl, readLinkState } = await import("./link");
const { checkChatLink, linkChatAccount } = await import("./link-account");

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const env = {
  AUTH_SECRET: "test-auth-secret",
  APP_URL: "https://omniralph.example.com/",
} as unknown as NodeJS.ProcessEnv;

const databaseAvailable = testDatabaseAvailable();

/** A fake Slack `users.info`: profiles by user ID, every call recorded. */
function fakeSlack(profiles: Record<string, Record<string, unknown>>) {
  const calls: Array<{ user: string | null; auth: string | null }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const user = new URLSearchParams(String(init?.body)).get("user");
    calls.push({ user, auth: new Headers(init?.headers).get("authorization") });
    const profile = user ? profiles[user] : undefined;
    return Response.json(
      profile
        ? { ok: true, user: { id: user, ...profile } }
        : { ok: false, error: "user_not_found" },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("fetchSlackUser", () => {
  it("reads the email and display name, and no email for bots or deleted users", async () => {
    const { fetch, calls } = fakeSlack({
      U1: { name: "ada", profile: { email: "ada@acme.test", display_name: "Ada" } },
      UBOT: { name: "bot", is_bot: true, profile: { email: "bot@acme.test" } },
      UGONE: { name: "gone", deleted: true, profile: { email: "gone@acme.test" } },
      UHIDDEN: { name: "hidden", real_name: "Hidden Person", profile: {} },
    });
    expect(await fetchSlackUser("xoxb-1", "U1", fetch)).toEqual({
      email: "ada@acme.test",
      displayName: "Ada",
    });
    expect(calls[0]).toEqual({ user: "U1", auth: "Bearer xoxb-1" });
    expect((await fetchSlackUser("xoxb-1", "UBOT", fetch)).email).toBeNull();
    expect((await fetchSlackUser("xoxb-1", "UGONE", fetch)).email).toBeNull();
    expect(await fetchSlackUser("xoxb-1", "UHIDDEN", fetch)).toEqual({
      email: null,
      displayName: "Hidden Person",
    });
    await expect(fetchSlackUser("xoxb-1", "UNONE", fetch)).rejects.toThrow("user_not_found");
  });
});

describe("link state", () => {
  const input = {
    organizationId: "org-1",
    connectionId: "conn-1",
    platform: "discord" as const,
    externalUserId: "D1",
    displayName: "Ada",
  };
  const stateOf = (url: string) => new URL(url).searchParams.get("state");

  it("is a signed /chat/link URL valid for 15 minutes", async () => {
    const now = new Date("2026-10-09T10:00:00Z");
    const url = await createLinkUrl(input, env, now);
    expect(url.startsWith("https://omniralph.example.com/chat/link?state=")).toBe(true);
    const state = stateOf(url);
    expect(await readLinkState(state, env, now)).toEqual({
      ok: true,
      state: {
        ...input,
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expiresAt: new Date(now.getTime() + CHAT_LINK_TTL_SECONDS * 1000),
      },
    });
    const almost = new Date(now.getTime() + (CHAT_LINK_TTL_SECONDS - 1) * 1000);
    expect((await readLinkState(state, env, almost)).ok).toBe(true);
    const expired = new Date(now.getTime() + (CHAT_LINK_TTL_SECONDS + 1) * 1000);
    expect(await readLinkState(state, env, expired)).toEqual({ ok: false, reason: "expired" });
  });

  it("has a unique id per link", async () => {
    const read = async () => {
      const result = await readLinkState(stateOf(await createLinkUrl(input, env)), env);
      return result.ok ? result.state.id : null;
    };
    const [a, b] = [await read(), await read()];
    expect(a).not.toBeNull();
    expect(a).not.toEqual(b);
  });

  it("rejects tampered, foreign and missing states", async () => {
    const state = stateOf(await createLinkUrl(input, env))!;
    const [header, payload, signature] = state.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, org: "org-2" })).toString("base64url");
    expect(await readLinkState(`${header}.${forged}.${signature}`, env)).toEqual({
      ok: false,
      reason: "invalid",
    });
    const other = { ...env, AUTH_SECRET: "other-secret" } as NodeJS.ProcessEnv;
    expect(await readLinkState(state, other)).toEqual({ ok: false, reason: "invalid" });
    expect(await readLinkState("not-a-jwt", env)).toEqual({ ok: false, reason: "invalid" });
    expect(await readLinkState(null, env)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe.skipIf(!databaseAvailable)("chat identities", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let slack: ChatConnection;
  let discord: ChatConnection;
  let otherSlack: ChatConnection;
  let now: Date;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    await db.insert(users).values([
      { id: "ada", email: "ada@acme.test", name: "Ada" },
      { id: "bob", email: "bob@acme.test", name: "Bob" },
      { id: "eve", email: "eve@other.test", name: "Eve" },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const connect = async (organizationId: string, platform: "slack" | "discord", id: string) => {
    const credentials: SlackCredentials | null =
      platform === "slack"
        ? {
            botToken: `xoxb-${id}`,
            botUserId: "UBOT",
            appId: "A1",
            scope: "users:read.email",
            teamId: id,
            isEnterpriseInstall: false,
          }
        : null;
    const saved = await saveChatConnection(
      db,
      {
        organizationId,
        platform,
        externalId: id,
        name: `${id} chat`,
        credentials,
        installedByUserId: null,
      },
      ENCRYPTION_KEY,
    );
    if (saved === "other_organization") throw new Error("taken");
    return saved;
  };

  beforeEach(async () => {
    await db.delete(organizations);
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: "ada", role: "admin" },
      { organizationId: orgId, userId: "bob", role: "member" },
      { organizationId: otherOrgId, userId: "eve", role: "admin" },
    ]);
    await setOrganizationDomains(db, orgId, ["acme.test"]);
    slack = await connect(orgId, "slack", "T1");
    discord = await connect(orgId, "discord", "G1");
    otherSlack = await connect(otherOrgId, "slack", "T2");
    now = new Date("2026-10-09T10:00:00Z");
  });

  const slackUsers = {
    UADA: { name: "ada", profile: { email: "ADA@acme.test", display_name: "Ada L" } },
    UCAROL: { name: "carol", profile: { email: "carol@acme.test", display_name: "Carol" } },
    UMAL: { name: "mal", profile: { email: "mal@elsewhere.test", display_name: "Mal" } },
    UNOEMAIL: { name: "restricted", profile: { display_name: "Restricted" } },
    UBOT2: { name: "a-bot", is_bot: true, profile: { email: "bot@acme.test" } },
  };

  const resolve = (
    connection: ChatConnection,
    externalUserId: string,
    fetchImpl: typeof fetch = fakeSlack(slackUsers).fetch,
  ) =>
    resolveChatActor(
      { db, fetch: fetchImpl, encryptionKey: ENCRYPTION_KEY, now: () => now },
      {
        organizationId: connection.organizationId,
        connection,
        platform: connection.platform,
        externalUserId,
      },
    );

  const linkState = async (connection: ChatConnection, externalUserId: string, at = now) =>
    new URL(
      await createLinkUrl(
        {
          organizationId: connection.organizationId,
          connectionId: connection.id,
          platform: connection.platform,
          externalUserId,
          displayName: `${externalUserId} name`,
        },
        env,
        at,
      ),
    ).searchParams.get("state");

  it("links a Slack user automatically when their email is a member's sign-in email", async () => {
    const slackApi = fakeSlack(slackUsers);
    expect(await resolve(slack, "UADA", slackApi.fetch)).toEqual({
      kind: "member",
      userId: "ada",
      role: "admin",
      name: "Ada",
      autoLinked: { email: "ADA@acme.test" },
    });
    expect(slackApi.calls).toEqual([{ user: "UADA", auth: "Bearer xoxb-T1" }]);
    expect(await getChatIdentity(db, orgId, "slack", "UADA")).toMatchObject({
      userId: "ada",
      source: "email",
      displayName: "Ada L",
    });
    // The next message finds the link: no note, no Slack call.
    expect(await resolve(slack, "UADA", slackApi.fetch)).toEqual({
      kind: "member",
      userId: "ada",
      role: "admin",
      name: "Ada",
    });
    expect(slackApi.calls).toHaveLength(1);
  });

  it("grants domain access to an unlinked Slack user with one of the organization's domains", async () => {
    expect(await resolve(slack, "UCAROL")).toEqual({ kind: "domain", email: "carol@acme.test" });
    expect(await getChatIdentity(db, orgId, "slack", "UCAROL")).toBeNull();
    expect(await resolve(slack, "UMAL")).toEqual({ kind: "unlinked" });
  });

  it("never grants domain access in an organization without email domains", async () => {
    await setOrganizationDomains(db, orgId, []);
    expect(await resolve(slack, "UCAROL")).toEqual({ kind: "unlinked" });
    // An exact email match still links.
    expect(await resolve(slack, "UADA")).toMatchObject({ kind: "member", userId: "ada" });
  });

  it("resolves Slack users without an email (restricted profiles, bots) to unlinked", async () => {
    expect(await resolve(slack, "UNOEMAIL")).toEqual({ kind: "unlinked" });
    expect(await resolve(slack, "UBOT2")).toEqual({ kind: "unlinked" });
    // Slack failing to answer is no access either, and nothing is cached.
    expect(await resolve(slack, "UNKNOWN")).toEqual({ kind: "unlinked" });
    expect(
      await db
        .select()
        .from(chatUserProfiles)
        .where(eq(chatUserProfiles.externalUserId, "UNKNOWN")),
    ).toEqual([]);
  });

  it("caches the Slack profile for an hour", async () => {
    const first = fakeSlack({ UX: { name: "x", profile: { email: "x@elsewhere.test" } } });
    expect(await resolve(slack, "UX", first.fetch)).toEqual({ kind: "unlinked" });
    expect(first.calls).toHaveLength(1);

    // Within the hour the cached email is used, even though Slack now says otherwise.
    const changed = fakeSlack({ UX: { name: "x", profile: { email: "x@acme.test" } } });
    now = new Date(now.getTime() + CHAT_PROFILE_TTL_MS - 1000);
    expect(await resolve(slack, "UX", changed.fetch)).toEqual({ kind: "unlinked" });
    expect(changed.calls).toHaveLength(0);

    // After it, Slack is asked again and the new email saved.
    now = new Date(now.getTime() + 2000);
    expect(await resolve(slack, "UX", changed.fetch)).toEqual({
      kind: "domain",
      email: "x@acme.test",
    });
    expect(changed.calls).toHaveLength(1);
    const [cached] = await db
      .select()
      .from(chatUserProfiles)
      .where(
        and(eq(chatUserProfiles.connectionId, slack.id), eq(chatUserProfiles.externalUserId, "UX")),
      );
    expect(cached).toMatchObject({ email: "x@acme.test", fetchedAt: now });
  });

  it("never looks Discord users up by email", async () => {
    const slackApi = fakeSlack(slackUsers);
    expect(await resolve(discord, "UADA", slackApi.fetch)).toEqual({ kind: "unlinked" });
    expect(slackApi.calls).toEqual([]);
  });

  it("links a chat user manually through a link and resolves them as that member", async () => {
    const state = await linkState(discord, "D1");
    expect(await checkChatLink(db, "bob", state, env, now)).toMatchObject({
      status: "ready",
      organizationName: "Acme",
      connectionName: "G1 chat",
      state: { platform: "discord", externalUserId: "D1", displayName: "D1 name" },
    });
    expect(await linkChatAccount(db, "bob", state, env, now)).toEqual({
      ok: true,
      platform: "discord",
      displayName: "D1 name",
      organizationName: "Acme",
    });
    expect(await getChatIdentity(db, orgId, "discord", "D1")).toMatchObject({
      userId: "bob",
      source: "manual",
      displayName: "D1 name",
    });
    expect(await resolve(discord, "D1")).toEqual({
      kind: "member",
      userId: "bob",
      role: "member",
      name: "Bob",
    });
    expect((await listChatIdentities(db, "bob")).map((i) => i.organizationName)).toEqual(["Acme"]);
  });

  it("replaces the first link when a chat user is linked to a second member", async () => {
    await linkChatAccount(db, "bob", await linkState(discord, "D1"), env, now);
    expect(
      await linkChatAccount(db, "ada", await linkState(discord, "D1"), env, now),
    ).toMatchObject({
      ok: true,
    });
    expect(await db.select().from(chatIdentities)).toHaveLength(1);
    expect(await resolve(discord, "D1")).toMatchObject({ kind: "member", userId: "ada" });
    expect(await listChatIdentities(db, "bob")).toEqual([]);
  });

  it("uses a link once: a replay by another member doesn't move the link", async () => {
    const state = await linkState(discord, "D1");
    expect(await linkChatAccount(db, "bob", state, env, now)).toMatchObject({ ok: true });
    expect(await checkChatLink(db, "ada", state, env, now)).toEqual({ status: "used" });
    expect(await linkChatAccount(db, "ada", state, env, now)).toEqual({
      ok: false,
      check: { status: "used" },
    });
    // Not even the member who used it can open it again.
    expect(await checkChatLink(db, "bob", state, env, now)).toEqual({ status: "used" });
    expect(await resolve(discord, "D1")).toMatchObject({ kind: "member", userId: "bob" });
  });

  it("links once when the same link is confirmed twice at the same time", async () => {
    const state = await linkState(discord, "D1");
    const results = await Promise.all([
      linkChatAccount(db, "bob", state, env, now),
      linkChatAccount(db, "ada", state, env, now),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, check: { status: "used" } }]);
    const winner = results[0]!.ok ? "bob" : "ada";
    expect(await resolve(discord, "D1")).toMatchObject({ kind: "member", userId: winner });
  });

  it("rejects expired and tampered links", async () => {
    const state = await linkState(discord, "D1");
    const later = new Date(now.getTime() + (CHAT_LINK_TTL_SECONDS + 1) * 1000);
    expect(await linkChatAccount(db, "bob", state, env, later)).toEqual({
      ok: false,
      check: { status: "expired" },
    });
    expect(await linkChatAccount(db, "bob", `${state}x`, env, now)).toEqual({
      ok: false,
      check: { status: "invalid" },
    });
    expect(await getChatIdentity(db, orgId, "discord", "D1")).toBeNull();
  });

  it("rejects a user who isn't a member of the link's organization", async () => {
    const state = await linkState(discord, "D1");
    expect(await checkChatLink(db, "eve", state, env, now)).toEqual({
      status: "not_member",
      organizationName: "Acme",
    });
    expect(await linkChatAccount(db, "eve", state, env, now)).toEqual({
      ok: false,
      check: { status: "not_member", organizationName: "Acme" },
    });
    expect(await getChatIdentity(db, orgId, "discord", "D1")).toBeNull();
  });

  it("rejects a link whose connection was removed or belongs to another organization", async () => {
    const forged = await createLinkUrl(
      {
        organizationId: orgId,
        connectionId: otherSlack.id,
        platform: "slack",
        externalUserId: "U9",
        displayName: "U9",
      },
      env,
      now,
    );
    const state = new URL(forged).searchParams.get("state");
    expect(await checkChatLink(db, "bob", state, env, now)).toEqual({ status: "not_connected" });
  });

  it("doesn't treat an ex-member's link as membership", async () => {
    await linkChatAccount(db, "bob", await linkState(discord, "D1"), env, now);
    await linkChatAccount(db, "bob", await linkState(slack, "UMAL"), env, now);
    await db
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, "bob")),
      );
    expect(await resolve(discord, "D1")).toEqual({ kind: "unlinked" });
    expect(await resolve(slack, "UMAL")).toEqual({ kind: "unlinked" });
    // An ex-member's Slack account with the organization's domain keeps read access only.
    await linkChatAccount(db, "ada", await linkState(slack, "UCAROL"), env, now);
    await db
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, "ada")),
      );
    expect(await resolve(slack, "UCAROL")).toEqual({ kind: "domain", email: "carol@acme.test" });
  });

  it("never links a chat user automatically again after they unlinked", async () => {
    expect(await resolve(slack, "UADA")).toMatchObject({
      kind: "member",
      autoLinked: expect.anything(),
    });
    expect(await unlinkChatIdentity(db, "ada", orgId, "slack", "UADA")).toBe(true);
    expect(await hasChatIdentityOptOut(db, orgId, "slack", "UADA")).toBe(true);

    // Opted out: the email still matches, but only the domain counts.
    expect(await resolve(slack, "UADA")).toEqual({ kind: "domain", email: "ADA@acme.test" });
    now = new Date(now.getTime() + CHAT_PROFILE_TTL_MS * 2);
    expect(await resolve(slack, "UADA")).toEqual({ kind: "domain", email: "ADA@acme.test" });
    expect(await getChatIdentity(db, orgId, "slack", "UADA")).toBeNull();

    // Linking manually withdraws the opt-out.
    await linkChatAccount(db, "ada", await linkState(slack, "UADA"), env, now);
    expect(await db.select().from(chatIdentityOptOuts)).toEqual([]);
    expect(await resolve(slack, "UADA")).toEqual({
      kind: "member",
      userId: "ada",
      role: "admin",
      name: "Ada",
    });
  });

  it("resolves nothing when the connection isn't the organization's", async () => {
    await linkChatAccount(db, "bob", await linkState(discord, "D1"), env, now);
    expect(
      await resolveChatActor(
        { db },
        {
          organizationId: otherOrgId,
          connection: discord,
          platform: "discord",
          externalUserId: "D1",
        },
      ),
    ).toEqual({ kind: "unlinked" });
  });
});
