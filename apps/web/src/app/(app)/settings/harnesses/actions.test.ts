import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  user: null as {
    id: string;
    role: Role;
    organization: { id: string; name: string };
    name: null;
    email: null;
    image: null;
  } | null,
  organizationId: null as string | null,
  version: null as string | null,
  updatedBy: null as string | null,
  latest: null as { version: string | null; error: string | null } | null,
  hostTools: [] as {
    id: string;
    organizationId: string;
    name: string;
    description: string | null;
  }[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", async () => {
  const { HOST_TOOL_NAME_PATTERN } = await import("@omniralph/shared");
  return {
    TRACK_LATEST_HARNESS_VERSION: "latest",
    // An in-memory host tool catalog with the db helpers' contract.
    createHostTool: async (
      _db: unknown,
      organizationId: string,
      input: { name: string; description?: string | null },
    ) => {
      if (!HOST_TOOL_NAME_PATTERN.test(input.name)) return { ok: false, error: "invalid_name" };
      if (
        state.hostTools.some((t) => t.organizationId === organizationId && t.name === input.name)
      ) {
        return { ok: false, error: "duplicate_name" };
      }
      const hostTool = {
        id: `00000000-0000-4000-8000-${String(state.hostTools.length + 1).padStart(12, "0")}`,
        organizationId,
        name: input.name,
        description: input.description ?? null,
      };
      state.hostTools.push(hostTool);
      return { ok: true, hostTool };
    },
    deleteHostTool: async (_db: unknown, organizationId: string, id: string) => {
      const before = state.hostTools.length;
      state.hostTools = state.hostTools.filter(
        (t) => !(t.organizationId === organizationId && t.id === id),
      );
      return state.hostTools.length < before;
    },
    getDesiredHarnessVersion: async () => state.version,
    getLatestHarnessVersionCheck: async () => null,
    setLatestHarnessVersionCheck: async (
      _db: unknown,
      _organizationId: string,
      check: { version: string | null; error: string | null },
    ) => {
      state.latest = check;
    },
    setDesiredHarnessVersion: async (
      _db: unknown,
      organizationId: string,
      version: string | null,
      updatedBy: string,
    ) => {
      state.organizationId = organizationId;
      state.version = version;
      state.updatedBy = updatedBy;
    },
  };
});

const { addHostTool, removeHostTool, setGlobalHarnessVersion, trackLatestHarnessVersion } =
  await import("./actions");

const REGISTRY = "https://registry.npmjs.org/@omniralph%2fharness";
const requests: { authorization: string | null; accept: string | null }[] = [];
let registry: () => Response = () => HttpResponse.json({ "dist-tags": { latest: "1.4.2" } });
const server = setupServer(
  http.get(REGISTRY, ({ request }) => {
    requests.push({
      authorization: request.headers.get("authorization"),
      accept: request.headers.get("accept"),
    });
    return registry();
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

const user = (role: Role) => ({
  id: `${role}-1`,
  role,
  organization: { id: "org-1", name: "Acme" },
  name: null,
  email: null,
  image: null,
});

describe("Settings › Harnesses actions", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.organizationId = null;
    state.version = null;
    state.updatedBy = null;
    state.latest = null;
    state.hostTools = [];
    requests.length = 0;
    registry = () => HttpResponse.json({ "dist-tags": { latest: "1.4.2" } });
  });

  it("sets the organization's version, which must be semver", async () => {
    expect(await setGlobalHarnessVersion(" 1.4.0 ")).toEqual({ ok: true });
    // The active organization's version.
    expect(state).toMatchObject({
      organizationId: "org-1",
      version: "1.4.0",
      updatedBy: "admin-1",
    });
    expect(await setGlobalHarnessVersion("v1.5.0-beta.1")).toEqual({ ok: true });
    expect(state.version).toBe("1.5.0-beta.1");

    for (const bad of ["1.4", "01.2.3", "1.2.3; rm -rf /", "next"]) {
      expect(await setGlobalHarnessVersion(bad)).toEqual({ ok: false, error: expect.any(String) });
    }
    expect(state.version).toBe("1.5.0-beta.1");

    expect(await setGlobalHarnessVersion("")).toEqual({ ok: true });
    expect(state.version).toBeNull();
  });

  it("is admin-only", async () => {
    state.user = user("member");
    expect(await setGlobalHarnessVersion("1.4.0")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(await trackLatestHarnessVersion()).toEqual({ ok: false, error: expect.any(String) });
    expect(await setGlobalHarnessVersion("latest")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(state.version).toBeNull();
    expect(requests).toEqual([]);
  });

  it("tracks the latest version on npm, read at once without a token", async () => {
    process.env.NPM_TOKEN = "npm_secret";
    try {
      expect(await trackLatestHarnessVersion()).toEqual({ ok: true, version: "1.4.2" });
    } finally {
      delete process.env.NPM_TOKEN;
    }
    // `latest` is stored, and the version read is recorded for heartbeats.
    expect(state.version).toBe("latest");
    expect(state.latest).toEqual({ version: "1.4.2", error: null });
    expect(requests).toEqual([
      { authorization: null, accept: "application/vnd.npm.install-v1+json" },
    ]);

    // Typing it works too.
    state.version = null;
    registry = () => HttpResponse.json({ "dist-tags": { latest: "1.5.0" } });
    expect(await setGlobalHarnessVersion(" Latest ")).toEqual({ ok: true, version: "1.5.0" });
    expect(state.version).toBe("latest");
    expect(state.latest).toEqual({ version: "1.5.0", error: null });
  });

  it("reports registry errors and keeps the version", async () => {
    registry = () => HttpResponse.json({ error: "Not found" }, { status: 404 });
    expect(await trackLatestHarnessVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("doesn't know @omniralph/harness"),
    });
    registry = () => HttpResponse.json({ "dist-tags": { latest: "not-a-version" } });
    expect(await trackLatestHarnessVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("didn't list a latest version"),
    });
    registry = () => new HttpResponse("oops", { status: 500 });
    expect(await trackLatestHarnessVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("answered 500"),
    });
    expect(state.version).toBeNull();
  });

  describe("host tools", () => {
    it("adds host tools to the organization's catalog", async () => {
      expect(await addHostTool({ name: " semgrep ", description: "  SAST scanner " })).toEqual({
        ok: true,
        hostToolId: expect.any(String),
      });
      expect(await addHostTool({ name: "opengrep", description: " " })).toMatchObject({ ok: true });
      expect(state.hostTools).toEqual([
        expect.objectContaining({
          organizationId: "org-1",
          name: "semgrep",
          description: "SAST scanner",
        }),
        expect.objectContaining({ organizationId: "org-1", name: "opengrep", description: null }),
      ]);
    });

    it("rejects invalid and duplicate names and long descriptions", async () => {
      for (const bad of ["", "Semgrep", "-x", "a/b", "../x", "x".repeat(65)]) {
        expect(await addHostTool({ name: bad })).toEqual({
          ok: false,
          error: expect.stringContaining("lowercase letters"),
        });
      }
      expect(await addHostTool({ name: "semgrep" })).toMatchObject({ ok: true });
      expect(await addHostTool({ name: "semgrep" })).toEqual({
        ok: false,
        error: "There already is a host tool named semgrep.",
      });
      expect(await addHostTool({ name: "ruff", description: "x".repeat(501) })).toEqual({
        ok: false,
        error: "Descriptions can be at most 500 characters.",
      });
      expect(state.hostTools.map((t) => t.name)).toEqual(["semgrep"]);
    });

    it("deletes only the organization's host tools", async () => {
      state.hostTools.push({
        id: "00000000-0000-4000-8000-0000000000ff",
        organizationId: "org-2",
        name: "semgrep",
        description: null,
      });
      const added = await addHostTool({ name: "semgrep" });
      if (!added.ok) throw new Error(added.error);
      expect(await removeHostTool("00000000-0000-4000-8000-0000000000ff")).toEqual({
        ok: false,
        error: "That host tool doesn't exist.",
      });
      expect(await removeHostTool("not-a-uuid")).toMatchObject({ ok: false });
      expect(await removeHostTool(added.hostToolId!)).toEqual({ ok: true });
      expect(await removeHostTool(added.hostToolId!)).toMatchObject({ ok: false });
      expect(state.hostTools).toEqual([expect.objectContaining({ organizationId: "org-2" })]);
    });

    it("is admin-only", async () => {
      const added = await addHostTool({ name: "semgrep" });
      if (!added.ok) throw new Error(added.error);
      state.user = user("member");
      expect(await addHostTool({ name: "ruff" })).toEqual({ ok: false, error: expect.any(String) });
      expect(await removeHostTool(added.hostToolId!)).toEqual({
        ok: false,
        error: expect.any(String),
      });
      expect(state.hostTools.map((t) => t.name)).toEqual(["semgrep"]);
    });
  });
});
