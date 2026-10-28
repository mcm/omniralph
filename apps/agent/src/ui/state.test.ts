import { effectiveLocalSettings } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import type { ClaudeStatus } from "../claude-status.js";
import type { DaemonStatus } from "../daemon.js";
import { silentLogger } from "../logger.js";
import type { StorageFilesystem } from "../storage.js";
import { agentUiState, type AgentUiStateSources } from "./state.js";

const STATUS: DaemonStatus = {
  stopping: false,
  draining: false,
  connected: true,
  lastHeartbeatAt: "2026-10-28T10:41:30.000Z",
  unreachableSince: null,
  revoked: false,
  runningJobIds: [],
  maxConcurrency: 5,
};

const SIGNED_IN: ClaudeStatus = {
  status: "signed_in",
  source: "login",
  account: { email: "steve@example.com", organization: null, subscriptionType: "max" },
  models: [],
  checkedAt: "2026-10-28T10:00:00.000Z",
};

const ROOMY: StorageFilesystem = {
  paths: ["/home"],
  freeBytes: 120e9,
  totalBytes: 500e9,
  low: false,
};

function sources(overrides: {
  status?: Partial<DaemonStatus>;
  missing?: string[];
  update?: ReturnType<AgentUiStateSources["updater"]["report"]>;
  claude?: ClaudeStatus | null;
  filesystems?: () => Promise<StorageFilesystem[]>;
}): AgentUiStateSources {
  return {
    agent: {
      agentId: "agent-1",
      name: "build-01",
      server: "https://omniralph.example",
      version: "2.0.3",
    },
    daemon: {
      status: () => ({ ...STATUS, ...overrides.status }),
      missingRequiredHostTools: () => overrides.missing ?? [],
    },
    settings: {
      read: () => ({
        settings: { v: 1 },
        effective: effectiveLocalSettings({ v: 1 }),
        revision: "none",
        lastError: null,
      }),
    },
    updater: {
      report: () =>
        overrides.update ?? {
          selfUpdate: "supported",
          failedVersions: [],
          update: {
            state: "idle",
            version: null,
            previous: null,
            startsSincePending: 0,
            error: null,
          },
        },
    },
    claude: { status: () => (overrides.claude === undefined ? SIGNED_IN : overrides.claude) },
    storage: { filesystems: overrides.filesystems ?? (async () => [ROOMY]) },
    logger: silentLogger(),
  };
}

describe("agentUiState", () => {
  it("collects the status, connection, settings, update, Claude and disk", async () => {
    const state = await agentUiState(sources({}));
    expect(state).toEqual({
      agent: {
        agentId: "agent-1",
        name: "build-01",
        server: "https://omniralph.example",
        version: "2.0.3",
      },
      status: STATUS,
      connection: {
        connected: true,
        lastHeartbeatAt: "2026-10-28T10:41:30.000Z",
        unreachableSince: null,
        revoked: false,
      },
      settings: expect.objectContaining({ revision: "none", lastError: null }),
      update: expect.objectContaining({ selfUpdate: "supported" }),
      claude: SIGNED_IN,
      missingRequiredHostTools: [],
      filesystems: [ROOMY],
      problems: [],
    });
  });

  it("names each problem on its nav item", async () => {
    const state = await agentUiState(
      sources({
        status: { unreachableSince: "2026-10-28T10:42:00.000Z" },
        missing: ["gh", "opengrep"],
        update: {
          selfUpdate: "supported",
          failedVersions: ["2.0.4"],
          update: {
            state: "idle",
            version: null,
            previous: null,
            startsSincePending: 0,
            error: "npm install failed",
          },
        },
        claude: { ...SIGNED_IN, status: "signed_out", source: null },
        filesystems: async () => [ROOMY, { ...ROOMY, paths: ["/data"], freeBytes: 1e9, low: true }],
      }),
    );
    expect(state.problems).toEqual([
      { section: "overview", reason: "can't reach the control panel" },
      { section: "host_tools", reason: "gh and opengrep required but not found" },
      { section: "version", reason: "the last update failed" },
      { section: "claude", reason: "not signed in" },
      { section: "storage", reason: "low disk" },
    ]);
  });

  it("says the agent was revoked over can't reach", async () => {
    const state = await agentUiState(
      sources({ status: { revoked: true, unreachableSince: "2026-10-28T10:42:00.000Z" } }),
    );
    expect(state.problems).toEqual([{ section: "overview", reason: "revoked" }]);
    expect(state.connection.revoked).toBe(true);
  });

  it("has no problem dot while an update runs, or before Claude was checked", async () => {
    const state = await agentUiState(
      sources({
        claude: null,
        update: {
          selfUpdate: "supported",
          failedVersions: [],
          update: {
            state: "installing",
            version: "2.0.4",
            previous: "2.0.3",
            startsSincePending: 0,
            error: "an older failure",
          },
        },
      }),
    );
    expect(state.problems).toEqual([]);
  });

  it("reports no filesystems when free space can't be read", async () => {
    const state = await agentUiState(
      sources({
        filesystems: async () => {
          throw new Error("statfs failed");
        },
      }),
    );
    expect(state.filesystems).toEqual([]);
    expect(state.problems).toEqual([]);
  });
});
