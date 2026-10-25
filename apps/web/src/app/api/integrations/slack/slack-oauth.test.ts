import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  saved: [] as Array<Record<string, unknown>>,
  /** Slack team/enterprise IDs connected to another organization. */
  takenWorkspaces: new Set<string>(),
  consumed: new Map<string, Date>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(state.user && { ...state.user, organization: { id: ORG_ID, name: "Acme" } }, role),
}));
// The change history is covered by the settings-history tests; here a connect just saves.
vi.mock("@/lib/settings-history/sections", () => ({
  settingsActor: () => ({ userId: null, name: "Admin" }),
  connectingWithHistory: <T>(
    db: unknown,
    _actor: unknown,
    _organizationId: string,
    _existingId: string | null,
    save: (tx: unknown) => Promise<T>,
  ) => save(db),
}));
vi.mock("@omniralph/db", () => ({
  consumeOAuthState: async (_db: unknown, nonce: string, expiresAt: Date) => {
    if (state.consumed.has(nonce)) return false;
    state.consumed.set(nonce, expiresAt);
    return true;
  },
  getChatConnectionByExternalId: async () => null,
  saveChatConnection: async (_db: unknown, values: Record<string, unknown>) => {
    if (state.takenWorkspaces.has(values.externalId as string)) return "other_organization";
    state.saved.push(values);
    return { id: "connection-1", ...values };
  },
}));

process.env.AUTH_SECRET = "test-auth-secret";
process.env.APP_URL = "https://omniralph.example.com";
process.env.SLACK_CLIENT_ID = "client-1";
process.env.SLACK_CLIENT_SECRET = "secret-1";
process.env.SLACK_SIGNING_SECRET = "signing-1";

const { GET: connect } = await import("./connect/route");
const { slackCallback } = await import("@/lib/chat/slack-install");
const { SLACK_BOT_SCOPES, SLACK_OAUTH_STATE_PURPOSE, SLACK_STATE_COOKIE, slackOAuthConfig } =
  await import("@/lib/chat/slack-oauth");
const { createSignedState } = await import("@/lib/auth/signed-state");

const createOAuthState = (userId: string, organizationId = ORG_ID) =>
  createSignedState(SLACK_OAUTH_STATE_PURPOSE, { userId, organizationId });

/** Fake `oauth.v2.access`: records requests and answers with `tokenResponse`. */
const tokenRequests: Array<{ url: string; body: URLSearchParams }> = [];
let tokenResponse: () => Response;
const TEAM_INSTALL = {
  ok: true,
  access_token: "xoxb-1",
  token_type: "bot",
  scope: SLACK_BOT_SCOPES.join(","),
  bot_user_id: "U0BOT",
  app_id: "A01",
  team: { id: "T01", name: "Acme Slack" },
  enterprise: null,
  is_enterprise_install: false,
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
  if (cookie !== undefined) headers.set("cookie", `${SLACK_STATE_COOKIE}=${cookie}`);
  return slackCallback(
    new NextRequest(`${BASE}/api/integrations/slack/callback?${query}`, { headers }),
    { fetch: fakeFetch },
  );
}

async function fresh() {
  const { state: signed, nonce } = await createOAuthState("admin-1");
  return { s: encodeURIComponent(signed), nonce };
}

beforeEach(() => {
  state.user = user("admin");
  state.saved = [];
  state.consumed.clear();
  state.takenWorkspaces.clear();
  tokenRequests.length = 0;
  tokenResponse = () => Response.json(TEAM_INSTALL);
});
afterEach(() => vi.restoreAllMocks());

describe("slackOAuthConfig", () => {
  it("is null unless the client ID, client secret and signing secret are all set", () => {
    const env = { SLACK_CLIENT_ID: "c", SLACK_CLIENT_SECRET: "s", SLACK_SIGNING_SECRET: "g" };
    const config = (vars: Record<string, string | undefined>) =>
      slackOAuthConfig(vars as unknown as NodeJS.ProcessEnv);
    expect(config(env)).toEqual({
      clientId: "c",
      clientSecret: "s",
      signingSecret: "g",
    });
    expect(config({})).toBeNull();
    for (const name of Object.keys(env)) {
      expect(config({ ...env, [name]: " " })).toBeNull();
      expect(config({ ...env, [name]: undefined })).toBeNull();
    }
  });
});

describe("docs/slack-app-manifest.yaml", () => {
  const manifest = readFileSync(
    new URL("../../../../../../../docs/slack-app-manifest.yaml", import.meta.url),
    "utf8",
  );
  const list = (key: string) => {
    const match = new RegExp(`\\n(\\s*)${key}:\\n((?:\\1\\s+- .+\\n)+)`).exec(manifest);
    return match
      ? match[2]!
          .split("\n")
          .filter(Boolean)
          .map((l) => l.trim().slice(2))
      : [];
  };

  it("requests exactly the bot scopes the connect flow asks for", () => {
    expect(list("bot")).toEqual(SLACK_BOT_SCOPES);
    expect(SLACK_BOT_SCOPES).toEqual(expect.arrayContaining(["users:read", "users:read.email"]));
  });

  it("subscribes to mentions, channel messages and uninstalls", () => {
    expect(list("bot_events")).toEqual(
      expect.arrayContaining([
        "app_mention",
        "message.channels",
        "message.groups",
        "app_uninstalled",
        "tokens_revoked",
      ]),
    );
    expect(manifest).toContain("/api/integrations/slack/callback");
    expect(manifest).toContain("/api/webhooks/slack");
  });
});

describe("GET /api/integrations/slack/connect", () => {
  it("redirects admins to Slack's install screen with the bot scopes and a signed state", async () => {
    const res = await connect(new NextRequest(`${BASE}/api/integrations/slack/connect`));
    const url = new URL(location(res));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(SLACK_BOT_SCOPES);
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/integrations/slack/callback`);
    const signedState = url.searchParams.get("state");
    expect(signedState?.split(".")).toHaveLength(3);

    const cookie = res.cookies.get(SLACK_STATE_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, path: "/api/integrations/slack/callback" });

    // The round trip with this state and cookie is accepted.
    const done = await callbackWith(`code=code-1&state=${signedState}`, cookie!.value);
    expect(location(done)).toBe("/settings/integrations?slack=connected");
  });

  it("refuses members and signed-out users", async () => {
    state.user = user("member");
    expect(location(await connect(new NextRequest(`${BASE}/api/integrations/slack/connect`)))).toBe(
      "/access-denied?reason=forbidden",
    );
    state.user = null;
    expect(location(await connect(new NextRequest(`${BASE}/api/integrations/slack/connect`)))).toBe(
      "/sign-in",
    );
  });

  it("reports an unconfigured Slack app", async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    try {
      expect(
        location(await connect(new NextRequest(`${BASE}/api/integrations/slack/connect`))),
      ).toBe("/settings/integrations?slack=not_configured");
    } finally {
      process.env.SLACK_SIGNING_SECRET = "signing-1";
    }
  });
});

describe("GET /api/integrations/slack/callback", () => {
  it("exchanges the code and stores the workspace and its bot token", async () => {
    const { s, nonce } = await fresh();
    const res = await callbackWith(`code=code-1&state=${s}`, nonce);
    expect(location(res)).toBe("/settings/integrations?slack=connected");
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(Object.fromEntries(tokenRequests[0]!.body)).toEqual({
      client_id: "client-1",
      client_secret: "secret-1",
      code: "code-1",
      redirect_uri: `${BASE}/api/integrations/slack/callback`,
    });
    expect(state.saved).toEqual([
      {
        organizationId: ORG_ID,
        platform: "slack",
        externalId: "T01",
        name: "Acme Slack",
        credentials: {
          botToken: "xoxb-1",
          botUserId: "U0BOT",
          appId: "A01",
          scope: SLACK_BOT_SCOPES.join(","),
          teamId: "T01",
          isEnterpriseInstall: false,
        },
        installedByUserId: "admin-1",
      },
    ]);
    // The one-time state cookie is cleared.
    expect(res.cookies.get(SLACK_STATE_COOKIE)?.value).toBe("");
  });

  it("stores an org-wide install under the enterprise", async () => {
    tokenResponse = () =>
      Response.json({
        ...TEAM_INSTALL,
        team: null,
        enterprise: { id: "E01", name: "Acme Grid" },
        is_enterprise_install: true,
      });
    const { s, nonce } = await fresh();
    expect(location(await callbackWith(`code=c&state=${s}`, nonce))).toBe(
      "/settings/integrations?slack=connected",
    );
    expect(state.saved).toEqual([
      expect.objectContaining({
        externalId: "E01",
        name: "Acme Grid",
        credentials: expect.objectContaining({ enterpriseId: "E01", isEnterpriseInstall: true }),
      }),
    ]);
    expect(state.saved[0]!.credentials).not.toHaveProperty("teamId");
  });

  it("consumes the state on first use and rejects a replayed callback", async () => {
    const { s, nonce } = await fresh();
    const query = `code=code-1&state=${s}`;
    expect(location(await callbackWith(query, nonce))).toBe(
      "/settings/integrations?slack=connected",
    );
    expect(location(await callbackWith(query, nonce))).toBe(
      "/settings/integrations?slack=invalid_state",
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
    const linear = await createSignedState("linear-oauth", {
      userId: "admin-1",
      organizationId: ORG_ID,
    });
    const cases: Array<[string, string | undefined]> = [
      [`code=code-1&state=${encodeURIComponent(otherOrg.state)}`, otherOrg.nonce],
      [`code=code-1&state=${encodeURIComponent(linear.state)}`, linear.nonce],
      ["code=code-1", nonce],
      [`code=code-1&state=`, nonce],
      [`code=code-1&state=forged`, nonce],
      [`code=code-1&state=${encodeURIComponent(otherAdmins)}`, nonce],
      [`code=code-1&state=${encodeURIComponent(signed)}`, undefined],
      [`code=code-1&state=${encodeURIComponent(signed)}`, "other-nonce"],
    ];
    for (const [query, cookie] of cases) {
      expect(location(await callbackWith(query, cookie))).toBe(
        "/settings/integrations?slack=invalid_state",
      );
    }
    expect(tokenRequests).toEqual([]);
    expect(state.saved).toEqual([]);
  });

  it("refuses a workspace connected to another organization", async () => {
    state.takenWorkspaces.add("T01");
    const { s, nonce } = await fresh();
    expect(location(await callbackWith(`code=c&state=${s}`, nonce))).toBe(
      "/settings/integrations?slack=other_organization",
    );
    expect(state.saved).toEqual([]);
  });

  it("reports a cancelled install without exchanging a code", async () => {
    const { s, nonce } = await fresh();
    expect(location(await callbackWith(`error=access_denied&state=${s}`, nonce))).toBe(
      "/settings/integrations?slack=denied",
    );
    expect(tokenRequests).toEqual([]);
  });

  it("reports an unconfigured Slack app", async () => {
    const { s, nonce } = await fresh();
    delete process.env.SLACK_CLIENT_SECRET;
    try {
      expect(location(await callbackWith(`code=c&state=${s}`, nonce))).toBe(
        "/settings/integrations?slack=not_configured",
      );
    } finally {
      process.env.SLACK_CLIENT_SECRET = "secret-1";
    }
    expect(tokenRequests).toEqual([]);
  });

  it("handles a missing code and token endpoint errors", async () => {
    let { s, nonce } = await fresh();
    expect(location(await callbackWith(`state=${s}`, nonce))).toBe(
      "/settings/integrations?slack=invalid",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: Array<() => Response> = [
      () => new Response("unavailable", { status: 503 }),
      () => Response.json({ ok: false, error: "invalid_code" }),
      () => Response.json({ ...TEAM_INSTALL, access_token: undefined }),
      () => Response.json({ ...TEAM_INSTALL, team: null }),
    ];
    for (const failure of failures) {
      tokenResponse = failure;
      ({ s, nonce } = await fresh());
      expect(location(await callbackWith(`code=bad&state=${s}`, nonce))).toBe(
        "/settings/integrations?slack=error",
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
