import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import { callAction } from "@/lib/api/test-call";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

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
  latestCheck: null as { version: string | null; error: string | null; checkedAt: Date } | null,
  allowedTaskTypes: null as string[] | null,
  maxConcurrency: null as number | null,
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
  requireSignedInUser: async () => assertRole(state.user, "member"),
}));
vi.mock("@omniralph/db", async () => {
  const { HOST_TOOL_NAME_PATTERN } = await import("@omniralph/shared");
  const { TASK_TYPES } = await import("@omniralph/tasks");
  return {
    // The change history is covered by its own tests: a save just runs.
    withSettingsChanges: async (
      db: unknown,
      _actor: unknown,
      _tracked: unknown,
      save: (tx: unknown) => Promise<unknown>,
    ) => save(db),
    TRACK_LATEST_HARNESS_VERSION: "latest",
    DESIRED_HARNESS_VERSION_KEY: "harness.desiredVersion",
    DEFAULT_ALLOWED_TASK_TYPES: ["query", "review", "coding"],
    DEFAULT_MAX_CONCURRENCY: 5,
    // Nothing saved: the built-in defaults, as the real getters return them.
    getAllowedTaskTypeDefaults: async () => state.allowedTaskTypes ?? ["query", "review", "coding"],
    getDefaultMaxConcurrency: async () => state.maxConcurrency ?? 5,
    getAppSetting: async () =>
      state.version === null
        ? null
        : {
            value: state.version,
            updatedBy: "admin-1",
            updatedAt: new Date("2026-10-01T00:00:00Z"),
          },
    listHostTools: async (_db: unknown, organizationId: string) =>
      state.hostTools
        .filter((t) => t.organizationId === organizationId)
        .map((t) => ({ ...t, createdAt: new Date(), updatedAt: new Date() })),
    MIN_MAX_CONCURRENCY: 1,
    MAX_MAX_CONCURRENCY: 32,
    // The organization-defaults setters, with their validation.
    setAllowedTaskTypeDefaults: async (
      _db: unknown,
      organizationId: string,
      types: string[] | null,
      updatedBy: string,
    ) => {
      if (types?.some((t) => !(TASK_TYPES as readonly string[]).includes(t))) {
        throw new Error("Unknown task types");
      }
      state.organizationId = organizationId;
      state.allowedTaskTypes = types;
      state.updatedBy = updatedBy;
    },
    setDefaultMaxConcurrency: async (
      _db: unknown,
      organizationId: string,
      maxConcurrency: number | null,
      updatedBy: string,
    ) => {
      if (
        maxConcurrency !== null &&
        !(Number.isInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 32)
      ) {
        throw new Error("Max concurrency must be an integer from 1 to 32");
      }
      state.organizationId = organizationId;
      state.maxConcurrency = maxConcurrency;
      state.updatedBy = updatedBy;
    },
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
    getLatestHarnessVersionCheck: async () => state.latestCheck,
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

const defaultsRoute = await import("@/app/api/ui/harness-defaults/route");
const hostToolsRoute = await import("@/app/api/ui/host-tools/route");
const hostToolRoute = await import("@/app/api/ui/host-tools/[id]/route");

// The Defaults and Host tools tabs' requests, under the names of the server actions they replace.
const saveDefaults = (body: unknown) => callAction(defaultsRoute.PUT, "PUT", {}, body);
const setGlobalHarnessVersion = (version: string) => saveDefaults({ version });
const trackLatestHarnessVersion = () => saveDefaults({ version: "latest" });
const setOrganizationDefaults = (defaults: unknown) => saveDefaults({ defaults });
const addHostTool = async (input: { name: string; description?: string }) =>
  (await callAction(hostToolsRoute.POST, "POST", {}, input)) as ActionResult & {
    hostToolId?: string;
  };
const removeHostTool = (id: string) => callAction(hostToolRoute.DELETE, "DELETE", { id });

async function getDefaults() {
  const response = await defaultsRoute.GET(new Request("http://localhost/api/ui"), {
    params: Promise.resolve({}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

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

describe("Settings › Harness defaults API", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.organizationId = null;
    state.version = null;
    state.updatedBy = null;
    state.latest = null;
    state.latestCheck = null;
    state.allowedTaskTypes = null;
    state.maxConcurrency = null;
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
      expect(await trackLatestHarnessVersion()).toEqual({ ok: true });
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
    expect(await setGlobalHarnessVersion(" Latest ")).toEqual({ ok: true });
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

  describe("the Defaults tab", () => {
    it("is for admins only", async () => {
      state.user = null;
      expect((await getDefaults()).status).toBe(401);
      state.user = user("member");
      expect((await getDefaults()).status).toBe(403);
    });

    it("shows the organization's version and built-in defaults", async () => {
      state.version = "1.4.0";
      expect(await getDefaults()).toEqual({
        status: 200,
        body: {
          desiredVersion: "1.4.0",
          updatedAt: "2026-10-01T00:00:00.000Z",
          latest: null,
          packageName: "@omniralph/harness",
          defaults: { allowedTaskTypes: ["query", "review", "coding"], maxConcurrency: 5 },
          builtInDefaults: { allowedTaskTypes: ["query", "review", "coding"], maxConcurrency: 5 },
        },
      });
    });

    it("shows the organization's saved defaults", async () => {
      state.allowedTaskTypes = ["review"];
      state.maxConcurrency = 2;
      expect((await getDefaults()).body).toMatchObject({
        desiredVersion: null,
        updatedAt: null,
        defaults: { allowedTaskTypes: ["review"], maxConcurrency: 2 },
        builtInDefaults: { allowedTaskTypes: ["query", "review", "coding"], maxConcurrency: 5 },
      });
    });

    it("shows the version read from npm when the organization tracks latest", async () => {
      state.version = "latest";
      state.latestCheck = { version: "1.5.0", error: null, checkedAt: new Date(Date.now() - 1000) };
      expect((await getDefaults()).body).toMatchObject({
        desiredVersion: "latest",
        latest: { version: "1.5.0", error: null, checkedAt: expect.any(String) },
      });
      expect(requests).toEqual([]);
    });

    it("saves the defaults, then the version, in one request; a failure names what isn't saved", async () => {
      expect(
        await saveDefaults({
          defaults: { allowedTaskTypes: ["review"], maxConcurrency: 4 },
          version: "1.6.0",
        }),
      ).toEqual({ ok: true });
      expect(state).toMatchObject({
        allowedTaskTypes: ["review"],
        maxConcurrency: 4,
        version: "1.6.0",
      });

      expect(
        await saveDefaults({
          defaults: { allowedTaskTypes: ["query"], maxConcurrency: 99 },
          version: "1.7.0",
        }),
      ).toEqual({
        ok: false,
        error:
          "Max concurrency must be 1–32 and task types known ones. Not saved: task types and concurrency and the desired version.",
      });
      expect(state).toMatchObject({ allowedTaskTypes: ["review"], version: "1.6.0" });

      // The defaults are saved before a bad version.
      expect(
        await saveDefaults({
          defaults: { allowedTaskTypes: ["coding"], maxConcurrency: 4 },
          version: "next",
        }),
      ).toEqual({
        ok: false,
        error:
          "Enter a version like 1.4.0 or latest, or leave it blank. Not saved: the desired version.",
      });
      expect(state).toMatchObject({ allowedTaskTypes: ["coding"], version: "1.6.0" });
    });
  });

  describe("organization defaults", () => {
    it("saves the organization's task types and max concurrency", async () => {
      expect(
        await setOrganizationDefaults({
          allowedTaskTypes: ["coding", "query"],
          maxConcurrency: 8,
        }),
      ).toEqual({ ok: true });
      expect(state).toMatchObject({
        organizationId: "org-1",
        allowedTaskTypes: ["coding", "query"],
        maxConcurrency: 8,
        updatedBy: "admin-1",
      });

      // No task types and the bounds are valid.
      expect(await setOrganizationDefaults({ allowedTaskTypes: [], maxConcurrency: 1 })).toEqual({
        ok: true,
      });
      expect(state).toMatchObject({ allowedTaskTypes: [], maxConcurrency: 1 });
      expect(
        await setOrganizationDefaults({
          allowedTaskTypes: ["query", "review", "coding"],
          maxConcurrency: 32,
        }),
      ).toEqual({ ok: true });
      expect(state).toMatchObject({
        allowedTaskTypes: ["query", "review", "coding"],
        maxConcurrency: 32,
      });
    });

    it("rejects unknown task types and max concurrency outside 1–32", async () => {
      for (const bad of [
        { allowedTaskTypes: ["query"], maxConcurrency: 0 },
        { allowedTaskTypes: ["query"], maxConcurrency: 33 },
        { allowedTaskTypes: ["query"], maxConcurrency: 2.5 },
        { allowedTaskTypes: ["query"], maxConcurrency: Number.NaN },
        { allowedTaskTypes: ["system"], maxConcurrency: 5 },
        { allowedTaskTypes: ["ralph"], maxConcurrency: 5 },
      ]) {
        expect(await setOrganizationDefaults(bad)).toEqual({
          ok: false,
          error: "Max concurrency must be 1–32 and task types known ones.",
        });
      }
      expect(state.allowedTaskTypes).toBeNull();
      expect(state.maxConcurrency).toBeNull();
    });

    it("is admin-only", async () => {
      state.user = user("member");
      expect(
        await setOrganizationDefaults({ allowedTaskTypes: ["query"], maxConcurrency: 3 }),
      ).toEqual({ ok: false, error: expect.any(String) });
      state.user = null;
      expect(
        await setOrganizationDefaults({ allowedTaskTypes: ["query"], maxConcurrency: 3 }),
      ).toEqual({ ok: false, error: expect.any(String) });
      expect(state.allowedTaskTypes).toBeNull();
      expect(state.maxConcurrency).toBeNull();
    });
  });

  describe("host tools", () => {
    it("lists the organization's catalog to its admins only", async () => {
      state.hostTools.push({
        id: "00000000-0000-4000-8000-0000000000ee",
        organizationId: "org-2",
        name: "theirs",
        description: null,
      });
      await addHostTool({ name: "semgrep", description: "SAST scanner" });
      const list = async () => {
        const response = await hostToolsRoute.GET(new Request("http://localhost/api/ui"), {
          params: Promise.resolve({}),
        });
        return { status: response.status, body: await response.json() };
      };
      expect(await list()).toEqual({
        status: 200,
        body: {
          hostTools: [{ id: expect.any(String), name: "semgrep", description: "SAST scanner" }],
        },
      });
      state.user = user("member");
      expect((await list()).status).toBe(403);
    });

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
