import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  installations: new Map<number, { id: number; account: string }>(),
  upserts: [] as Array<Record<string, unknown>>,
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
  beforeEach(() => {
    state.user = user("admin");
    state.installations = new Map([[42, { id: 42, account: "acme" }]]);
    state.upserts = [];
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
