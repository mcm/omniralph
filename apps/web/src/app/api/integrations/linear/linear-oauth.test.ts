import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  saved: [] as Array<Record<string, unknown>>,
  consumed: new Map<string, Date>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", () => ({
  consumeOAuthState: async (_db: unknown, nonce: string, expiresAt: Date) => {
    if (state.consumed.has(nonce)) return false;
    state.consumed.set(nonce, expiresAt);
    return true;
  },
  saveIntegration: async (_db: unknown, values: Record<string, unknown>) => {
    state.saved.push(values);
    return { id: "integration-1", ...values };
  },
}));

process.env.AUTH_SECRET = "test-auth-secret";
process.env.APP_URL = "https://omniralph.example.com";
process.env.LINEAR_CLIENT_ID = "client-1";
process.env.LINEAR_CLIENT_SECRET = "secret-1";

const { GET: connect } = await import("./connect/route");
const { GET: callback } = await import("./callback/route");
const { createOAuthState, STATE_COOKIE } = await import("@/lib/linear/oauth");

const tokenRequests: URLSearchParams[] = [];
let tokenStatus = 200;
const server = setupServer(
  http.post("https://api.linear.app/oauth/token", async ({ request }) => {
    tokenRequests.push(new URLSearchParams(await request.text()));
    if (tokenStatus !== 200)
      return HttpResponse.json({ error: "invalid_grant" }, { status: tokenStatus });
    return HttpResponse.json({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 86_400,
      token_type: "Bearer",
      scope: "read,write,app:assignable,app:mentionable",
    });
  }),
  http.post("https://api.linear.app/graphql", ({ request }) => {
    expect(request.headers.get("authorization")).toBe("Bearer access-1");
    return HttpResponse.json({ data: { organization: { id: "org-1", name: "Acme" } } });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });
const BASE = "https://omniralph.example.com";

function location(res: Response): string {
  expect(res.status).toBe(307);
  const url = new URL(res.headers.get("location")!);
  return url.origin === BASE ? url.pathname + url.search : url.toString();
}

async function callbackWith(query: string, cookie?: string) {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", `${STATE_COOKIE}=${cookie}`);
  return callback(
    new NextRequest(`${BASE}/api/integrations/linear/callback?${query}`, { headers }),
  );
}

beforeEach(() => {
  state.user = user("admin");
  state.saved = [];
  state.consumed.clear();
  tokenRequests.length = 0;
  tokenStatus = 200;
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/integrations/linear/connect", () => {
  it("redirects admins to Linear OAuth with actor=app, the agent scopes and a signed state", async () => {
    const res = await connect(new NextRequest(`${BASE}/api/integrations/linear/connect`));
    const url = new URL(location(res));
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("scope")).toBe("read,write,app:assignable,app:mentionable");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/integrations/linear/callback`);
    const signedState = url.searchParams.get("state");
    expect(signedState?.split(".")).toHaveLength(3);

    const cookie = res.cookies.get(STATE_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, path: "/api/integrations/linear/callback" });

    // The round trip with this state and cookie is accepted.
    const done = await callbackWith(`code=code-1&state=${signedState}`, cookie!.value);
    expect(location(done)).toBe("/settings/integrations?linear=connected");
  });

  it("refuses members and signed-out users", async () => {
    state.user = user("member");
    expect(
      location(await connect(new NextRequest(`${BASE}/api/integrations/linear/connect`))),
    ).toBe("/access-denied?reason=forbidden");
    state.user = null;
    expect(
      location(await connect(new NextRequest(`${BASE}/api/integrations/linear/connect`))),
    ).toBe("/sign-in");
  });

  it("reports an unconfigured Linear app", async () => {
    delete process.env.LINEAR_CLIENT_ID;
    try {
      expect(
        location(await connect(new NextRequest(`${BASE}/api/integrations/linear/connect`))),
      ).toBe("/settings/integrations?linear=not_configured");
    } finally {
      process.env.LINEAR_CLIENT_ID = "client-1";
    }
  });
});

describe("GET /api/integrations/linear/callback", () => {
  it("exchanges the code and stores the tokens and workspace", async () => {
    const { state: signed, nonce } = await createOAuthState("admin-1");
    const res = await callbackWith(`code=code-1&state=${encodeURIComponent(signed)}`, nonce);
    expect(location(res)).toBe("/settings/integrations?linear=connected");
    expect(Object.fromEntries(tokenRequests[0]!)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: `${BASE}/api/integrations/linear/callback`,
      client_id: "client-1",
      client_secret: "secret-1",
    });
    expect(state.saved).toEqual([
      {
        provider: "linear",
        externalId: "org-1",
        name: "Acme",
        credentials: {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresAt: expect.any(String),
          scope: "read,write,app:assignable,app:mentionable",
        },
        installedByUserId: "admin-1",
      },
    ]);
    // The one-time state cookie is cleared.
    expect(res.cookies.get(STATE_COOKIE)?.value).toBe("");
  });

  it("consumes the state on first use and rejects a replayed callback", async () => {
    const { state: signed, nonce } = await createOAuthState("admin-1");
    const query = `code=code-1&state=${encodeURIComponent(signed)}`;
    expect(location(await callbackWith(query, nonce))).toBe(
      "/settings/integrations?linear=connected",
    );
    // Consumed until the state would have expired.
    const expiresAt = state.consumed.get(nonce)!;
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);

    expect(location(await callbackWith(query, nonce))).toBe(
      "/settings/integrations?linear=invalid_state",
    );
    expect(tokenRequests).toHaveLength(1);
    expect(state.saved).toHaveLength(1);

    // A declined consent uses the state up as well.
    const declined = await createOAuthState("admin-1");
    const declinedQuery = `error=access_denied&state=${encodeURIComponent(declined.state)}`;
    expect(location(await callbackWith(declinedQuery, declined.nonce))).toBe(
      "/settings/integrations?linear=denied",
    );
    expect(
      location(
        await callbackWith(`code=c&state=${encodeURIComponent(declined.state)}`, declined.nonce),
      ),
    ).toBe("/settings/integrations?linear=invalid_state");
  });

  it("rejects a missing, forged, foreign or cookie-less state without exchanging the code", async () => {
    const { state: signed, nonce } = await createOAuthState("admin-1");
    const { state: otherAdmins } = await createOAuthState("admin-2");
    const cases: Array<[string, string | undefined]> = [
      ["code=code-1", nonce],
      [`code=code-1&state=`, nonce],
      [`code=code-1&state=forged`, nonce],
      [`code=code-1&state=${encodeURIComponent(otherAdmins)}`, nonce],
      [`code=code-1&state=${encodeURIComponent(signed)}`, undefined],
      [`code=code-1&state=${encodeURIComponent(signed)}`, "other-nonce"],
    ];
    for (const [query, cookie] of cases) {
      expect(location(await callbackWith(query, cookie))).toBe(
        "/settings/integrations?linear=invalid_state",
      );
    }
    expect(tokenRequests).toEqual([]);
    expect(state.saved).toEqual([]);
  });

  it("handles a declined consent, a missing code and token errors", async () => {
    const fresh = async () => {
      const { state: signed, nonce } = await createOAuthState("admin-1");
      return { s: encodeURIComponent(signed), nonce };
    };
    let { s, nonce } = await fresh();
    expect(location(await callbackWith(`error=access_denied&state=${s}`, nonce))).toBe(
      "/settings/integrations?linear=denied",
    );
    ({ s, nonce } = await fresh());
    expect(location(await callbackWith(`state=${s}`, nonce))).toBe(
      "/settings/integrations?linear=invalid",
    );
    tokenStatus = 400;
    vi.spyOn(console, "error").mockImplementation(() => {});
    ({ s, nonce } = await fresh());
    expect(location(await callbackWith(`code=bad&state=${s}`, nonce))).toBe(
      "/settings/integrations?linear=error",
    );
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
