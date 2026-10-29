import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentUiState } from "../../src/ui/state.js";
import {
  AGENT_UI_FIXTURE_ENV,
  AGENT_UI_FIXTURE_REFUSED,
  FIXTURE_ATTEMPTS,
  FIXTURE_INSTALLS,
  FIXTURE_MISSING_HOST_TOOL,
  startAgentUiFixture,
  type AgentUiFixture,
} from "./fixture.js";
import { AGENT_SCREEN_ROUTES } from "./routes.js";

const BUNDLE_DIR = "/nonexistent/agent-ui-bundle";

describe("startAgentUiFixture", () => {
  it.each([{}, { [AGENT_UI_FIXTURE_ENV]: "0" }, { [AGENT_UI_FIXTURE_ENV]: "true" }])(
    "refuses to start without %s=1 (%o)",
    async (env) => {
      await expect(startAgentUiFixture({ env, bundleDir: BUNDLE_DIR })).rejects.toThrow(
        AGENT_UI_FIXTURE_REFUSED,
      );
    },
  );
});

describe("the fixture page's API", () => {
  let fixture: AgentUiFixture;
  let cookie: string;

  beforeAll(async () => {
    fixture = await startAgentUiFixture({
      env: { [AGENT_UI_FIXTURE_ENV]: "1" },
      bundleDir: BUNDLE_DIR,
    });
    // The link signs in, as it does a browser.
    const signIn = await fetch(fixture.link, { redirect: "manual" });
    expect(signIn.status).toBe(303);
    cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterAll(async () => {
    await fixture?.close();
  });

  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${fixture.server.url}${path}`, { headers: { cookie } });
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  }

  async function put(path: string, body: unknown): Promise<Response> {
    return fetch(`${fixture.server.url}${path}`, {
      method: "PUT",
      headers: { cookie, origin: fixture.server.url, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("answers only with the link's token", async () => {
    const response = await fetch(`${fixture.server.url}/api/state`);
    expect(response.status).toBe(401);
  });

  it("has settings with slots, pool limits, accepted kinds and a version pin", async () => {
    const state = await get<AgentUiState>("/api/state");
    expect(state.settings.lastError).toBeNull();
    expect(state.settings.effective).toMatchObject({
      maxConcurrency: 6,
      poolLimits: { long: 2, short: 4 },
      acceptedTaskTypes: ["review", "coding"],
      versionPin: state.agent.version,
    });
    expect(state.versionPolicy?.version).not.toBe(state.agent.version);
    expect(state.update.failedVersions).toHaveLength(1);
    expect(state.status.runningJobIds).toEqual([
      FIXTURE_ATTEMPTS.runningStory,
      FIXTURE_ATTEMPTS.runningReview,
    ]);
  });

  it("is missing one required host tool, the only problem in the nav", async () => {
    const state = await get<AgentUiState>("/api/state");
    const byName = new Map(state.hostTools.tools.map((tool) => [tool.name, tool]));
    expect(byName.get(FIXTURE_MISSING_HOST_TOOL)).toMatchObject({
      problem: "missing",
      path: null,
      required: true,
    });
    expect(byName.get("gh")).toMatchObject({ source: "configured", problem: null });
    expect(byName.get("git")).toMatchObject({ source: "discovered", checkedPath: null });
    expect(state.missingRequiredHostTools).toEqual([FIXTURE_MISSING_HOST_TOOL]);
    expect(state.problems).toEqual([
      { section: "host_tools", reason: `${FIXTURE_MISSING_HOST_TOOL} required but not found` },
    ]);
  });

  it("checks a saved host tool path, as the next heartbeat would", async () => {
    const before = await get<AgentUiState>("/api/state");
    const hostTools = {
      ...before.settings.effective.hostTools,
      [FIXTURE_MISSING_HOST_TOOL]: "/opt/terraform/1.9/bin/terraform",
    };
    const saved = await put("/api/settings/host-tools", {
      revision: before.settings.revision,
      hostTools,
    });
    expect(saved.status).toBe(200);
    const after = await get<AgentUiState>("/api/state");
    expect(after.missingRequiredHostTools).toEqual([]);
    expect(after.problems).toEqual([]);
    // Back to the seeded state for the other tests.
    const restored = await put("/api/settings/host-tools", {
      revision: after.settings.revision,
      hostTools: before.settings.effective.hostTools,
    });
    expect(restored.status).toBe(200);
  });

  it("has Claude signed in with its models", async () => {
    const { claude } = await get<AgentUiState>("/api/state");
    expect(claude?.status).toBe("signed_in");
    expect(claude?.account?.email).toBeTruthy();
    expect(claude?.models.length).toBeGreaterThan(1);
  });

  it("has installables installed, one updating and one failed", async () => {
    const { packages } = await get<{ packages: { name: string; version: string }[] }>(
      "/api/packages",
    );
    expect(packages.length).toBeGreaterThan(1);
    const { installs } = await get<{
      installs: {
        id: string;
        name: string;
        outcome: string | null;
        previousVersion: string | null;
      }[];
    }>("/api/packages/history");
    const byId = new Map(installs.map((install) => [install.id, install]));
    const updating = byId.get(FIXTURE_INSTALLS.updating);
    expect(updating?.outcome).toBeNull();
    // An update of an installed package, at its installed version.
    expect(packages).toContainEqual({ name: updating?.name, version: updating?.previousVersion });
    expect(byId.get(FIXTURE_INSTALLS.failed)?.outcome).toBe("failed");
    expect(byId.get(FIXTURE_INSTALLS.installed)?.outcome).toBe("installed");
    const failed = await get<{ output: string; error: string }>(
      `/api/packages/history/${FIXTURE_INSTALLS.failed}`,
    );
    expect(failed.output).toMatch(/404/);
  });

  it("has workspace and disk usage, and repos whose last sync failed for one", async () => {
    const storage = await get<{
      items: { key: string; bytes: number }[];
      filesystems: { paths: string[]; low: boolean }[];
      roots: { workspaceRoot: string; dataDir: string };
    }>("/api/storage");
    expect(storage.items.map((item) => item.key)).toEqual([
      "repo_cache",
      "worktrees",
      "branch_worktrees",
      "packages",
      "caches",
      "logs",
    ]);
    expect(storage.items.every((item) => item.bytes > 0)).toBe(true);
    expect(storage.filesystems.flatMap((fs) => fs.paths).sort()).toEqual(
      [storage.roots.workspaceRoot, storage.roots.dataDir].sort(),
    );
    const { repos } = await get<{ repos: { lastSync: { outcome: string } | null }[] }>(
      "/api/repos",
    );
    expect(repos.filter((repo) => repo.lastSync?.outcome === "failed")).toHaveLength(1);
    expect(repos.filter((repo) => repo.lastSync?.outcome === "completed").length).toBeGreaterThan(
      0,
    );
  });

  it("has local logs, with warnings and errors", async () => {
    const all = await get<{ entries: { level: string }[] }>("/api/logs");
    const warn = await get<{ entries: { level: string }[] }>("/api/logs?level=warn");
    expect(all.entries.length).toBeGreaterThan(warn.entries.length);
    expect(new Set(warn.entries.map((entry) => entry.level))).toEqual(new Set(["warn", "error"]));
  });

  it("has running attempts, one with a live transcript and log tail, and finished ones", async () => {
    const attempts = await get<{
      running: { id: string }[];
      recent: { id: string; outcome: string }[];
    }>("/api/attempts");
    expect(attempts.running.map((attempt) => attempt.id)).toContain(FIXTURE_ATTEMPTS.runningStory);
    expect(new Set(attempts.recent.map((attempt) => attempt.outcome))).toEqual(
      new Set(["completed", "failed", "canceled"]),
    );
    const tail = await get<{ events: unknown[]; log: { fields: { jobId: string } }[] }>(
      `/api/attempts/${FIXTURE_ATTEMPTS.runningStory}`,
    );
    expect(tail.events.length).toBeGreaterThan(0);
    expect(tail.log.length).toBeGreaterThan(0);
    expect(tail.log.every((line) => line.fields.jobId === FIXTURE_ATTEMPTS.runningStory)).toBe(
      true,
    );
  });

  it("serves every attempt and install the captured routes open", async () => {
    for (const route of AGENT_SCREEN_ROUTES) {
      const attempt = /^\/attempts\/(.+)$/.exec(route.path);
      if (attempt) await get(`/api/attempts/${attempt[1]}`);
      const install = /^\/packages\/history\/(.+)$/.exec(route.path);
      if (install) await get(`/api/packages/history/${install[1]}`);
    }
  });
});
