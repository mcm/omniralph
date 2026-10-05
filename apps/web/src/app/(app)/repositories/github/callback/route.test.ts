import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  installations: new Map<number, { id: number; account: string }>(),
  upserts: [] as Array<Record<string, unknown>>,
  /** Thrown by getInstallation instead of a lookup (auth/config/network failures). */
  failure: null as unknown,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@/lib/scm/github-app", () => ({
  getGitHubAppAuth: () => ({}),
  githubApiUrl: () => "https://api.github.com",
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
  upsertScmConnection: async (_db: unknown, values: Record<string, unknown>) => {
    state.upserts.push(values);
    return { id: "conn-1", ...values };
  },
}));

const { GET } = await import("./route");

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });

async function callback(query: string): Promise<string | null> {
  const res = await GET(
    new NextRequest(`https://omniralph.example.com/repositories/github/callback?${query}`),
  );
  expect(res.status).toBe(307);
  const location = res.headers.get("location");
  return location && new URL(location).pathname + new URL(location).search;
}

describe("GET /repositories/github/callback", () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    state.user = user("admin");
    state.installations = new Map([[42, { id: 42, account: "acme" }]]);
    state.upserts = [];
    state.failure = null;
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("stores the installation as a connection and opens its repository picker", async () => {
    expect(await callback("installation_id=42&setup_action=install")).toBe(
      "/repositories/github/conn-1",
    );
    expect(state.upserts).toEqual([
      {
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "42",
        credentials: {},
        createdBy: "admin-1",
      },
    ]);
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
