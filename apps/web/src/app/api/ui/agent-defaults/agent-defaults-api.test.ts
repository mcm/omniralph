import { spawnSync } from "node:child_process";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
  requireSignedInUser: async () => assertRole(state.user, "member"),
}));
vi.mock("@omniralph/db", async () => {
  return {
    // The change history is covered by its own tests: a save just runs.
    withSettingsChanges: async (
      db: unknown,
      _actor: unknown,
      _tracked: unknown,
      save: (tx: unknown) => Promise<unknown>,
    ) => save(db),
    TRACK_LATEST_AGENT_VERSION: "latest",
    DESIRED_AGENT_VERSION_KEY: "agent.desiredVersion",
    getAppSetting: async () =>
      state.version === null
        ? null
        : {
            value: state.version,
            updatedBy: "admin-1",
            updatedAt: new Date("2026-10-01T00:00:00Z"),
          },
    getDesiredAgentVersion: async () => state.version,
    getLatestAgentVersionCheck: async () => state.latestCheck,
    setLatestAgentVersionCheck: async (
      _db: unknown,
      _organizationId: string,
      check: { version: string | null; error: string | null },
    ) => {
      state.latest = check;
    },
    setDesiredAgentVersion: async (
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

const defaultsRoute = await import("@/app/api/ui/agent-defaults/route");

// The Defaults tab's requests, under the names of the server actions they replace.
const saveDefaults = (body: unknown) => callAction(defaultsRoute.PUT, "PUT", {}, body);
const setGlobalAgentVersion = (version: string) => saveDefaults({ version });
const trackLatestAgentVersion = () => saveDefaults({ version: "latest" });

async function getDefaults() {
  const response = await defaultsRoute.GET(new Request("http://localhost/api/ui"), {
    params: Promise.resolve({}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const REGISTRY = "https://registry.npmjs.org/@omniralph%2fagent";
const requests: { authorization: string | null; accept: string | null }[] = [];
let registry: () => Response = () => HttpResponse.json({ "dist-tags": { latest: "2.4.2" } });
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

describe("Agent defaults API", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.organizationId = null;
    state.version = null;
    state.updatedBy = null;
    state.latest = null;
    state.latestCheck = null;
    requests.length = 0;
    registry = () => HttpResponse.json({ "dist-tags": { latest: "2.4.2" } });
  });

  it("sets the organization's version, which must be semver", async () => {
    expect(await setGlobalAgentVersion(" 2.4.0 ")).toEqual({
      ok: true,
      versionPolicy: { mode: "pinned", version: "2.4.0", target: "2.4.0" },
    });
    // The active organization's version.
    expect(state).toMatchObject({
      organizationId: "org-1",
      version: "2.4.0",
      updatedBy: "admin-1",
    });
    expect(await setGlobalAgentVersion("v2.5.0-beta.1")).toEqual({
      ok: true,
      versionPolicy: { mode: "pinned", version: "2.5.0-beta.1", target: "2.5.0-beta.1" },
    });
    expect(state.version).toBe("2.5.0-beta.1");

    for (const bad of ["1.4", "01.2.3", "2.2.3; rm -rf /", "next"]) {
      expect(await setGlobalAgentVersion(bad)).toEqual({ ok: false, error: expect.any(String) });
    }
    expect(state.version).toBe("2.5.0-beta.1");

    // Blank: versions aren't managed.
    expect(await setGlobalAgentVersion("")).toEqual({
      ok: true,
      versionPolicy: { mode: "unset", version: null, target: null },
    });
    expect(state.version).toBeNull();
  });

  it("rejects a version below @omniralph/agent 2.0.0 with a field error", async () => {
    state.version = "2.4.0";
    const error = "Agents run @omniralph/agent 2.0.0 or later: enter 2.0.0 or a later version.";
    for (const old of ["1.9.9", "0.8.0", "v1.9.9"]) {
      expect(await setGlobalAgentVersion(old)).toEqual({
        ok: false,
        error: expect.stringContaining(error),
        fieldErrors: { version: error },
      });
    }
    expect(state.version).toBe("2.4.0");
    expect(await setGlobalAgentVersion("2.0.0")).toEqual({
      ok: true,
      versionPolicy: { mode: "pinned", version: "2.0.0", target: "2.0.0" },
    });
    expect(state.version).toBe("2.0.0");
  });

  it("doesn't track a latest below 2.0.0 on npm", async () => {
    registry = () => HttpResponse.json({ "dist-tags": { latest: "0.8.0" } });
    expect(await trackLatestAgentVersion()).toEqual({
      ok: false,
      error: "Couldn't read the latest version: No @omniralph/agent 2.0.0 or later on npm yet.",
    });
    expect(state.version).toBeNull();
    expect(state.latest).toBeNull();
    registry = () => HttpResponse.json({ "dist-tags": { latest: "2.0.0" } });
    expect(await trackLatestAgentVersion()).toEqual({
      ok: true,
      versionPolicy: { mode: "latest", version: null, target: "2.0.0" },
    });
    expect(state.latest).toEqual({ version: "2.0.0", error: null });
  });

  it("is admin-only", async () => {
    state.user = user("member");
    expect(await setGlobalAgentVersion("2.4.0")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(await trackLatestAgentVersion()).toEqual({ ok: false, error: expect.any(String) });
    expect(await setGlobalAgentVersion("latest")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(state.version).toBeNull();
    expect(requests).toEqual([]);
  });

  it("tracks the latest version on npm, read at once without a token", async () => {
    process.env.NPM_TOKEN = "npm_secret";
    try {
      expect(await trackLatestAgentVersion()).toEqual({
        ok: true,
        versionPolicy: { mode: "latest", version: null, target: "2.4.2" },
      });
    } finally {
      delete process.env.NPM_TOKEN;
    }
    // `latest` is stored, and the version read is recorded for heartbeats.
    expect(state.version).toBe("latest");
    expect(state.latest).toEqual({ version: "2.4.2", error: null });
    expect(requests).toEqual([
      { authorization: null, accept: "application/vnd.npm.install-v1+json" },
    ]);

    // Typing it works too.
    state.version = null;
    registry = () => HttpResponse.json({ "dist-tags": { latest: "2.5.0" } });
    expect(await setGlobalAgentVersion(" Latest ")).toEqual({
      ok: true,
      versionPolicy: { mode: "latest", version: null, target: "2.5.0" },
    });
    expect(state.version).toBe("latest");
    expect(state.latest).toEqual({ version: "2.5.0", error: null });
  });

  it("reports registry errors and keeps the version", async () => {
    registry = () => HttpResponse.json({ error: "Not found" }, { status: 404 });
    expect(await trackLatestAgentVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("doesn't know @omniralph/agent"),
    });
    registry = () => HttpResponse.json({ "dist-tags": { latest: "not-a-version" } });
    expect(await trackLatestAgentVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("didn't list a latest version"),
    });
    registry = () => new HttpResponse("oops", { status: 500 });
    expect(await trackLatestAgentVersion()).toEqual({
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

    it("shows the organization's version, and no slots: they're each agent's own", async () => {
      state.version = "2.4.0";
      expect(await getDefaults()).toEqual({
        status: 200,
        body: {
          desiredVersion: "2.4.0",
          updatedAt: "2026-10-01T00:00:00.000Z",
          latest: null,
          packageName: "@omniralph/agent",
        },
      });
      state.version = null;
      expect((await getDefaults()).body).toMatchObject({ desiredVersion: null, updatedAt: null });
    });

    it("shows the version read from npm when the organization tracks latest", async () => {
      state.version = "latest";
      state.latestCheck = { version: "2.5.0", error: null, checkedAt: new Date(Date.now() - 1000) };
      expect((await getDefaults()).body).toMatchObject({
        desiredVersion: "latest",
        latest: { version: "2.5.0", error: null, checkedAt: expect.any(String) },
      });
      expect(requests).toEqual([]);
    });

    it("saves the version, answering the version policy it set", async () => {
      // The answer carries the version policy the save set (Fleet's cell).
      expect(await saveDefaults({ version: "2.6.0" })).toEqual({
        ok: true,
        versionPolicy: { mode: "pinned", version: "2.6.0", target: "2.6.0" },
      });
      expect(state).toMatchObject({ version: "2.6.0", updatedBy: "admin-1" });
      expect(await saveDefaults({ version: "next" })).toEqual({
        ok: false,
        error: "Enter a version like 2.0.0 or latest, or leave it blank.",
      });
      expect(state).toMatchObject({ version: "2.6.0" });
      // Nothing to save.
      expect(await saveDefaults({})).toEqual({ ok: true });
    });

    it("refuses slots and task types with 400 and saves nothing: each agent decides its own", async () => {
      for (const body of [
        { maxConcurrency: 4 },
        { maxConcurrency: 4, version: "2.6.0" },
        { defaults: { maxConcurrency: 4 } },
        { defaults: { maxConcurrency: 4 }, version: "2.6.0" },
        { acceptedTaskTypes: ["review"] },
        { acceptedTaskTypes: ["review"], version: "2.6.0" },
        { defaults: { acceptedTaskTypes: ["review"], maxConcurrency: 4 } },
      ]) {
        const response = await defaultsRoute.PUT(
          new Request("http://localhost/api/ui", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({}) },
        );
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(state).toMatchObject({ version: null, updatedBy: null });
    });

    it("never reads or writes an organization slot default in app_settings", () => {
      // Built here so this file doesn't match itself.
      const key = ["agent", "maxConcurrency"].join(".");
      const root = path.resolve(import.meta.dirname, "../../../../../../..");
      // Old migrations name it, as history.
      const grep = spawnSync(
        "git",
        ["grep", "-nF", key, "--", "apps", "packages", ":!packages/db/drizzle"],
        { cwd: root, encoding: "utf8" },
      );
      // `git grep` exits 1 when nothing matches.
      expect(grep.stdout).toBe("");
      expect(grep.status).toBe(1);
    });
  });
});
