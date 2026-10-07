import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

interface Connection {
  id: string;
  organizationId: string;
  externalId: string;
}

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  /** The signed-in user's active organization. */
  orgId: "org-a",
  installations: new Map<number, { id: number; account: string }>(),
  /** Stored connections (by installation ID). */
  connections: new Map<string, Connection>(),
  upserts: [] as Array<Record<string, unknown>>,
  usedNonces: new Set<string>(),
  /** Thrown by getInstallation instead of a lookup (auth/config/network failures). */
  failure: null as unknown,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/scm/github-app", () => ({
  getGitHubAppAuth: () => ({}),
  githubApiUrl: () => "https://api.github.com",
  getGitHubInstallUrl: async () => "https://github.com/apps/omniralph/installations/new",
  GITHUB_CALLBACK_PATH: "/repositories/github/callback",
  GITHUB_INSTALL_COOKIE: "omniralph_github_install",
  GITHUB_INSTALL_STATE_PURPOSE: "github-install",
}));
vi.mock("@omniralph/scm", () => ({
  getInstallation: async (_auth: unknown, id: number) => {
    if (state.failure) throw state.failure;
    const installation = state.installations.get(id);
    // Installations of other apps 404 for our app JWT.
    if (!installation) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { ...installation, accountType: "Organization", repositorySelection: "selected" };
  },
}));
vi.mock("@omniralph/db", () => ({
  consumeOAuthState: async (_db: unknown, nonce: string) => {
    if (state.usedNonces.has(nonce)) return false;
    state.usedNonces.add(nonce);
    return true;
  },
  findScmConnection: async (_db: unknown, _provider: string, _baseUrl: string, id: string) =>
    state.connections.get(id) ?? null,
  upsertScmConnection: async (
    _db: unknown,
    values: { organizationId: string; externalId: string },
  ) => {
    state.upserts.push(values);
    const existing = state.connections.get(values.externalId);
    // A connection belongs to one organization.
    if (existing && existing.organizationId !== values.organizationId) return null;
    const connection = existing ?? { id: `conn-${values.externalId}`, ...values };
    state.connections.set(values.externalId, connection);
    return connection;
  },
}));

process.env.AUTH_SECRET = "test-auth-secret";

const { GET } = await import("./route");
const { GET: install } = await import("../install/route");
const { createSignedState, readSignedState } = await import("@/lib/auth/signed-state");

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });
const COOKIE = "omniralph_github_install";

/** A state and nonce cookie as `/repositories/github/install` would have set them. */
async function signed(organizationId = state.orgId, userId = "admin-1") {
  return createSignedState("github-install", { userId, organizationId });
}

async function callback(
  query: string,
  flow: { state: string; nonce: string } | null | "fresh" = "fresh",
): Promise<string | null> {
  const started = flow === "fresh" ? await signed() : flow;
  const params = new URLSearchParams(query);
  if (started) params.set("state", started.state);
  const res = await GET(
    new NextRequest(`https://omniralph.example.com/repositories/github/callback?${params}`, {
      headers: started ? { cookie: `${COOKIE}=${started.nonce}` } : {},
    }),
  );
  expect(res.status).toBe(307);
  const location = res.headers.get("location");
  return location && new URL(location).pathname + new URL(location).search;
}

describe("GET /repositories/github/callback", () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    state.user = user("admin");
    state.orgId = "org-a";
    state.installations = new Map([[42, { id: 42, account: "acme" }]]);
    state.connections = new Map();
    state.upserts = [];
    state.usedNonces = new Set();
    state.failure = null;
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("stores the installation in the state's organization and opens its repository picker", async () => {
    expect(await callback("installation_id=42&setup_action=install")).toBe(
      "/repositories/github/conn-42",
    );
    expect(state.upserts).toEqual([
      {
        organizationId: "org-a",
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "42",
        credentials: {},
        createdBy: "admin-1",
      },
    ]);
  });

  it("clears the state cookie", async () => {
    const res = await GET(
      new NextRequest(
        "https://omniralph.example.com/repositories/github/callback?installation_id=42",
      ),
    );
    expect(res.headers.get("set-cookie")).toContain(`${COOKIE}=;`);
  });

  it("refuses an installation another organization already connected", async () => {
    expect(await callback("installation_id=42")).toBe("/repositories/github/conn-42");
    state.orgId = "org-b";
    expect(await callback("installation_id=42")).toBe("/repositories?github=other_organization");
    expect(state.connections.get("42")).toMatchObject({ organizationId: "org-a" });
  });

  it("connects an installation to another organization once the first one removed it", async () => {
    expect(await callback("installation_id=42")).toBe("/repositories/github/conn-42");
    state.orgId = "org-b";
    expect(await callback("installation_id=42")).toBe("/repositories?github=other_organization");
    // Org A removes the connection (Remove on the Repositories page, or GitHub's uninstall
    // webhook): the row is deleted, see deleteScmConnection.
    state.connections.delete("42");
    expect(await callback("installation_id=42")).toBe("/repositories/github/conn-42");
    expect(state.connections.get("42")).toMatchObject({ organizationId: "org-b" });
  });

  it("refuses missing, replayed, foreign and other-organization states", async () => {
    const started = await signed();
    expect(await callback("installation_id=42", started)).toBe("/repositories/github/conn-42");
    state.connections.clear();
    state.upserts = [];
    // Replayed.
    expect(await callback("installation_id=42", started)).toBe(
      "/repositories?github=invalid_state",
    );
    // None (e.g. installed straight from GitHub).
    expect(await callback("installation_id=42", null)).toBe("/repositories?github=invalid_state");
    // Without the browser's nonce cookie.
    const other = await signed();
    expect(
      await callback("installation_id=42", { state: other.state, nonce: "someone-else" }),
    ).toBe("/repositories?github=invalid_state");
    // Started by another admin.
    expect(await callback("installation_id=42", await signed("org-a", "admin-2"))).toBe(
      "/repositories?github=invalid_state",
    );
    // Started in another organization than the one the admin now works in.
    expect(await callback("installation_id=42", await signed("org-b"))).toBe(
      "/repositories?github=invalid_state",
    );
    expect(state.upserts).toEqual([]);
  });

  it("opens an installation the organization already has without a state", async () => {
    state.connections.set("42", { id: "conn-42", organizationId: "org-a", externalId: "42" });
    expect(await callback("installation_id=42&setup_action=update", null)).toBe(
      "/repositories/github/conn-42",
    );
    state.orgId = "org-b";
    expect(await callback("installation_id=42&setup_action=update", null)).toBe(
      "/repositories?github=invalid_state",
    );
    expect(state.upserts).toEqual([]);
  });

  it("refuses installations that aren't ours and malformed IDs", async () => {
    expect(await callback("installation_id=7&setup_action=install")).toBe(
      "/repositories?github=invalid",
    );
    for (const id of ["", "abc", "-1", "0", "1.5", "99999999999999999999"]) {
      expect(await callback(`installation_id=${id}`)).toBe("/repositories?github=invalid");
    }
    expect(state.upserts).toEqual([]);
  });

  it("logs a 404 with the installation ID and keeps github=invalid", async () => {
    expect(await callback("installation_id=7&setup_action=install")).toBe(
      "/repositories?github=invalid",
    );
    expect(consoleError).toHaveBeenCalledWith("GitHub installation 7 lookup failed", {
      status: 404,
      name: "Error",
      message: "Not Found",
    });
  });

  it("reports auth, config and network failures as github=error and logs them", async () => {
    const failures: Array<[unknown, number | undefined, string]> = [
      // GitHub rejects the app JWT (bad KMS/PEM signature, wrong GITHUB_APP_ID).
      [
        Object.assign(new Error("A JSON web token could not be decoded"), {
          status: 401,
          request: { headers: { authorization: "bearer secret-app-jwt" } },
        }),
        401,
        "A JSON web token could not be decoded",
      ],
      // Signing fails before any request (e.g. KMS refuses or the key is missing).
      [new Error("KMS signing failed"), undefined, "KMS signing failed"],
      [Object.assign(new TypeError("fetch failed"), { status: 500 }), 500, "fetch failed"],
      ["boom", undefined, "boom"],
    ];
    for (const [failure, status, message] of failures) {
      state.failure = failure;
      consoleError.mockClear();
      expect(await callback("installation_id=42&setup_action=install")).toBe(
        "/repositories?github=error",
      );
      expect(consoleError).toHaveBeenCalledTimes(1);
      const [text, details] = consoleError.mock.calls[0]!;
      expect(text).toBe("GitHub installation 42 lookup failed");
      expect(details).toMatchObject({ status, message });
      // Never the request (and its Authorization header).
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret-app-jwt");
    }
    expect(state.upserts).toEqual([]);
  });

  it("reports a requested (not yet approved) installation", async () => {
    expect(await callback("setup_action=request")).toBe("/repositories?github=requested");
    expect(state.upserts).toEqual([]);
  });

  it("sends members to access denied and signed-out users to sign in", async () => {
    state.user = user("member");
    expect(await callback("installation_id=42")).toBe("/access-denied?reason=forbidden");
    state.user = null;
    expect(await callback("installation_id=42")).toBe("/sign-in");
    expect(state.upserts).toEqual([]);
  });
});

describe("GET /repositories/github/install", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.orgId = "org-a";
  });

  const start = () =>
    install(new NextRequest("https://omniralph.example.com/repositories/github/install"));

  it("sends admins to the app's installation page with a state for their organization", async () => {
    const res = await start();
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://github.com/apps/omniralph/installations/new",
    );
    const cookie = res.cookies.get(COOKIE);
    expect(cookie).toMatchObject({ path: "/repositories/github/callback", httpOnly: true });
    const read = await readSignedState("github-install", location.searchParams.get("state"), {
      userId: "admin-1",
      nonce: cookie?.value,
    });
    expect(read).toMatchObject({ organizationId: "org-a" });
  });

  it("refuses members", async () => {
    state.user = user("member");
    const res = await start();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/access-denied");
  });
});
