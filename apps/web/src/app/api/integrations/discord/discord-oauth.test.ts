import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  saved: [] as Array<Record<string, unknown>>,
  /** Discord guild IDs connected to another organization. */
  takenGuilds: new Set<string>(),
  consumed: new Map<string, Date>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(state.user && { ...state.user, organization: { id: ORG_ID, name: "Acme" } }, role),
}));
vi.mock("@omniralph/db", () => ({
  consumeOAuthState: async (_db: unknown, nonce: string, expiresAt: Date) => {
    if (state.consumed.has(nonce)) return false;
    state.consumed.set(nonce, expiresAt);
    return true;
  },
  saveChatConnection: async (_db: unknown, values: Record<string, unknown>) => {
    if (state.takenGuilds.has(values.externalId as string)) return "other_organization";
    state.saved.push(values);
    return { id: "connection-1", ...values };
  },
}));

const ENV = {
  DISCORD_APPLICATION_ID: "app-1",
  DISCORD_CLIENT_SECRET: "secret-1",
  DISCORD_BOT_TOKEN: "bot-token-1",
  DISCORD_PUBLIC_KEY: "public-key-1",
};
process.env.AUTH_SECRET = "test-auth-secret";
process.env.APP_URL = "https://omniralph.example.com";
Object.assign(process.env, ENV);

const { GET: connect } = await import("./connect/route");
const { discordCallback } = await import("@/lib/chat/discord-install");
const {
  DISCORD_BOT_PERMISSIONS,
  DISCORD_OAUTH_STATE_PURPOSE,
  DISCORD_STATE_COOKIE,
  discordOAuthConfig,
} = await import("@/lib/chat/discord-oauth");
const { createSignedState } = await import("@/lib/auth/signed-state");

const createOAuthState = (userId: string, organizationId = ORG_ID) =>
  createSignedState(DISCORD_OAUTH_STATE_PURPOSE, { userId, organizationId });

/** Fake token endpoint: records requests and answers with `tokenResponse`. */
const tokenRequests: Array<{ url: string; body: URLSearchParams }> = [];
let tokenResponse: () => Response;
const BOT_ADDED = {
  access_token: "user-access-1",
  token_type: "Bearer",
  expires_in: 604800,
  refresh_token: "refresh-1",
  scope: "bot applications.commands",
  guild: { id: "G01", name: "Acme Discord" },
};
const fakeFetch: typeof fetch = async (input, init) => {
  tokenRequests.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
  return tokenResponse();
};

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });
const BASE = "https://omniralph.example.com";

function location(res: Response): string {
  expect(res.status).toBe(307);
  const url = new URL(res.headers.get("location")!);
  return url.origin === BASE ? url.pathname + url.search : url.toString();
}

async function callbackWith(query: string, cookie?: string) {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", `${DISCORD_STATE_COOKIE}=${cookie}`);
  return discordCallback(
    new NextRequest(`${BASE}/api/integrations/discord/callback?${query}`, { headers }),
    { fetch: fakeFetch },
  );
}

async function fresh() {
  const { state: signed, nonce } = await createOAuthState("admin-1");
  return { s: encodeURIComponent(signed), nonce };
}

const connectRequest = () => new NextRequest(`${BASE}/api/integrations/discord/connect`);

beforeEach(() => {
  state.user = user("admin");
  state.saved = [];
  state.consumed.clear();
  state.takenGuilds.clear();
  tokenRequests.length = 0;
  tokenResponse = () => Response.json(BOT_ADDED);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(process.env, ENV);
});

describe("discordOAuthConfig", () => {
  it("is null unless the application ID, client secret, bot token and public key are all set", () => {
    const config = (vars: Record<string, string | undefined>) =>
      discordOAuthConfig(vars as unknown as NodeJS.ProcessEnv);
    expect(config(ENV)).toEqual({
      applicationId: "app-1",
      clientSecret: "secret-1",
      botToken: "bot-token-1",
      publicKey: "public-key-1",
    });
    expect(config({})).toBeNull();
    for (const name of Object.keys(ENV)) {
      expect(config({ ...ENV, [name]: " " })).toBeNull();
      expect(config({ ...ENV, [name]: undefined })).toBeNull();
    }
  });
});

describe("GET /api/integrations/discord/connect", () => {
  it("redirects admins to Discord's add-bot screen with the bot scopes, permissions and a signed state", async () => {
    const res = await connect(connectRequest());
    const url = new URL(location(res));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("app-1");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/integrations/discord/callback`);
    // View Channels, Send Messages, Send Messages in Threads, Create Public
    // Threads, Read Message History and Add Reactions; nothing else.
    expect(url.searchParams.get("permissions")).toBe("309237713984");
    expect(DISCORD_BOT_PERMISSIONS).toBe(
      (1n << 10n) | (1n << 11n) | (1n << 38n) | (1n << 35n) | (1n << 16n) | (1n << 6n),
    );
    const signedState = url.searchParams.get("state");
    expect(signedState?.split(".")).toHaveLength(3);

    const cookie = res.cookies.get(DISCORD_STATE_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, path: "/api/integrations/discord/callback" });

    // The round trip with this state and cookie is accepted.
    const done = await callbackWith(
      `code=code-1&guild_id=G01&permissions=309237713984&state=${signedState}`,
      cookie!.value,
    );
    expect(location(done)).toBe("/settings/integrations?discord=connected");
  });

  it("refuses members and signed-out users", async () => {
    state.user = user("member");
    expect(location(await connect(connectRequest()))).toBe("/access-denied?reason=forbidden");
    state.user = null;
    expect(location(await connect(connectRequest()))).toBe("/sign-in");
  });

  it("reports an unconfigured Discord app", async () => {
    delete process.env.DISCORD_PUBLIC_KEY;
    expect(location(await connect(connectRequest()))).toBe(
      "/settings/integrations?discord=not_configured",
    );
  });
});

describe("GET /api/integrations/discord/callback", () => {
  it("exchanges the code and stores the token response's guild without credentials", async () => {
    const { s, nonce } = await fresh();
    const res = await callbackWith(`code=code-1&guild_id=G01&state=${s}`, nonce);
    expect(location(res)).toBe("/settings/integrations?discord=connected");
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.url).toBe("https://discord.com/api/oauth2/token");
    expect(Object.fromEntries(tokenRequests[0]!.body)).toEqual({
      client_id: "app-1",
      client_secret: "secret-1",
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: `${BASE}/api/integrations/discord/callback`,
    });
    expect(state.saved).toEqual([
      {
        organizationId: ORG_ID,
        platform: "discord",
        externalId: "G01",
        name: "Acme Discord",
        credentials: null,
        installedByUserId: "admin-1",
      },
    ]);
    // The one-time state cookie is cleared.
    expect(res.cookies.get(DISCORD_STATE_COOKIE)?.value).toBe("");
  });

  it("rejects a token response whose guild differs from the query's guild_id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { s, nonce } = await fresh();
    expect(location(await callbackWith(`code=code-1&guild_id=G99&state=${s}`, nonce))).toBe(
      "/settings/integrations?discord=error",
    );
    expect(state.saved).toEqual([]);
  });

  it("consumes the state on first use and rejects a replayed callback", async () => {
    const { s, nonce } = await fresh();
    const query = `code=code-1&guild_id=G01&state=${s}`;
    expect(location(await callbackWith(query, nonce))).toBe(
      "/settings/integrations?discord=connected",
    );
    expect(location(await callbackWith(query, nonce))).toBe(
      "/settings/integrations?discord=invalid_state",
    );
    expect(tokenRequests).toHaveLength(1);
    expect(state.saved).toHaveLength(1);
  });

  it("rejects a missing, forged, foreign or cookie-less state without exchanging the code", async () => {
    const { state: signed, nonce } = await createOAuthState("admin-1");
    const { state: otherAdmins } = await createOAuthState("admin-2");
    // Signed for the admin, but for an organization they aren't working in.
    const otherOrg = await createOAuthState("admin-1", "22222222-2222-4222-8222-222222222222");
    // Signed for another flow.
    const slack = await createSignedState("slack-oauth", {
      userId: "admin-1",
      organizationId: ORG_ID,
    });
    const cases: Array<[string, string | undefined]> = [
      [`code=code-1&state=${encodeURIComponent(otherOrg.state)}`, otherOrg.nonce],
      [`code=code-1&state=${encodeURIComponent(slack.state)}`, slack.nonce],
      ["code=code-1", nonce],
      [`code=code-1&state=`, nonce],
      [`code=code-1&state=forged`, nonce],
      [`code=code-1&state=${encodeURIComponent(otherAdmins)}`, nonce],
      [`code=code-1&state=${encodeURIComponent(signed)}`, undefined],
      [`code=code-1&state=${encodeURIComponent(signed)}`, "other-nonce"],
    ];
    for (const [query, cookie] of cases) {
      expect(location(await callbackWith(query, cookie))).toBe(
        "/settings/integrations?discord=invalid_state",
      );
    }
    expect(tokenRequests).toEqual([]);
    expect(state.saved).toEqual([]);
  });

  it("refuses a server connected to another organization", async () => {
    state.takenGuilds.add("G01");
    const { s, nonce } = await fresh();
    expect(location(await callbackWith(`code=c&guild_id=G01&state=${s}`, nonce))).toBe(
      "/settings/integrations?discord=other_organization",
    );
    expect(state.saved).toEqual([]);
  });

  it("reports a cancelled authorization without exchanging a code", async () => {
    const { s, nonce } = await fresh();
    expect(
      location(
        await callbackWith(
          `error=access_denied&error_description=The+resource+owner+denied&state=${s}`,
          nonce,
        ),
      ),
    ).toBe("/settings/integrations?discord=denied");
    expect(tokenRequests).toEqual([]);
  });

  it("reports an unconfigured Discord app", async () => {
    const { s, nonce } = await fresh();
    delete process.env.DISCORD_BOT_TOKEN;
    expect(location(await callbackWith(`code=c&guild_id=G01&state=${s}`, nonce))).toBe(
      "/settings/integrations?discord=not_configured",
    );
    expect(tokenRequests).toEqual([]);
  });

  it("handles a missing code and token endpoint errors", async () => {
    let { s, nonce } = await fresh();
    expect(location(await callbackWith(`state=${s}`, nonce))).toBe(
      "/settings/integrations?discord=invalid",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: Array<() => Response> = [
      () => new Response("unavailable", { status: 503 }),
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      () => Response.json({ ...BOT_ADDED, access_token: undefined }),
      // Without the bot scope Discord adds no guild to the token response.
      () => Response.json({ ...BOT_ADDED, guild: undefined }),
    ];
    for (const failure of failures) {
      tokenResponse = failure;
      ({ s, nonce } = await fresh());
      expect(location(await callbackWith(`code=bad&guild_id=G01&state=${s}`, nonce))).toBe(
        "/settings/integrations?discord=error",
      );
    }
    expect(state.saved).toEqual([]);
  });

  it("refuses members and signed-out users", async () => {
    const { state: signed, nonce } = await createOAuthState("member-1");
    state.user = user("member");
    expect(location(await callbackWith(`code=c&state=${encodeURIComponent(signed)}`, nonce))).toBe(
      "/access-denied?reason=forbidden",
    );
    state.user = null;
    expect(location(await callbackWith(`code=c&state=${encodeURIComponent(signed)}`, nonce))).toBe(
      "/sign-in",
    );
    expect(tokenRequests).toEqual([]);
  });
});
