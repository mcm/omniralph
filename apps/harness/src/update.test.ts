import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HeartbeatResponse } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.js";
import {
  SelfUpdater,
  npmInstaller,
  readUpdateState,
  runningUnderPm2,
  updateRequestPath,
  updateStatePath,
  writeUpdateRequest,
  writeUpdateState,
  type DrainableDaemon,
  type Installer,
  type UpdateStateFile,
} from "./update.js";

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => childProcess);

function config(desiredVersion: string | null): HeartbeatResponse {
  return {
    maxConcurrency: 1,
    pollIntervalSeconds: 5,
    enabledCapabilities: ["review"],
    capabilityLimits: {},
    pinnedRepoIds: [],
    organizationId: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
    topics: [],
    queueRegion: "iad1",
    cancelJobIds: [],
    jobTokens: [],
    jobMessages: [],
    desiredVersion,
    updateRequest: null,
  };
}

/** Records installs; `fail` makes the next installs of those versions throw. */
function fakeInstaller(fail: string[] = [], latest = "1.2.0") {
  const installs: string[] = [];
  const installer: Installer = {
    install: async (version) => {
      installs.push(version);
      if (fail.includes(version)) throw new Error(`npm ERR! 404 ${version} not found`);
    },
    latest: async () => latest,
  };
  return { installs, installer };
}

function fakeDaemon() {
  const calls: string[] = [];
  const daemon: DrainableDaemon & { stopping: boolean } = {
    stopping: false,
    drain: async (timeoutMs) => void calls.push(`drain ${timeoutMs}`),
    resume: () => void calls.push("resume"),
    exitForUpdate: () => void calls.push("exit"),
    isStopping() {
      return this.stopping;
    },
  };
  return { calls, daemon };
}

/** A clock the tests move by hand. */
function fakeClock(start = 1_000_000) {
  const clock = { now: start, tick: (ms: number) => (clock.now += ms) };
  return clock;
}

describe("SelfUpdater", () => {
  let dir: string;
  let statePath: string;
  let requestPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-update-"));
    statePath = updateStatePath(path.join(dir, "harness.json"));
    requestPath = updateRequestPath(path.join(dir, "harness.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function updater(
    options: {
      version?: string;
      underPm2?: boolean;
      installer?: Installer;
      clock?: ReturnType<typeof fakeClock>;
    } = {},
  ) {
    const clock = options.clock ?? fakeClock();
    return new SelfUpdater({
      statePath,
      requestPath,
      runningVersion: options.version ?? "1.0.0",
      underPm2: options.underPm2 ?? true,
      installer: options.installer ?? fakeInstaller().installer,
      logger: silentLogger(),
      now: () => clock.now,
    });
  }

  const readState = async () => JSON.parse(await readFile(statePath, "utf8")) as UpdateStateFile;

  it("keeps the update state next to the agent config", () => {
    expect(updateStatePath("/home/a/.config/omniralph/harness.json")).toBe(
      "/home/a/.config/omniralph/update-state.json",
    );
  });

  it("detects pm2 from pm_id", () => {
    expect(runningUnderPm2({ pm_id: "0" })).toBe(true);
    expect(runningUnderPm2({})).toBe(false);
  });

  it("does nothing while the desired version is the running one, or none is chosen", async () => {
    const { installs, installer } = fakeInstaller();
    const { calls, daemon } = fakeDaemon();
    const u = updater({ installer });
    expect(await u.start()).toBe("run");
    await u.onHeartbeat(config("1.0.0"), daemon);
    await u.onHeartbeat(config(null), daemon);
    expect(installs).toEqual([]);
    expect(calls).toEqual([]);
    expect(u.report()).toEqual({
      selfUpdate: "supported",
      update: {
        state: "idle",
        version: null,
        previous: null,
        startsSincePending: 0,
        error: null,
      },
      failedVersions: [],
      handledUpdateRequestId: null,
    });
  });

  it("drains, installs, writes the update state (0600) and exits for pm2", async () => {
    const { installs, installer } = fakeInstaller();
    const { calls, daemon } = fakeDaemon();
    const reports: unknown[] = [];
    const u = updater({ installer });
    await u.start();
    daemon.drain = async (timeoutMs) => {
      calls.push(`drain ${timeoutMs}`);
      reports.push(u.report().update);
    };
    await u.onHeartbeat(config("1.1.0"), daemon);

    expect(calls).toEqual([`drain ${2 * 60 * 60 * 1000}`, "exit"]);
    expect(reports).toEqual([
      expect.objectContaining({ state: "draining", version: "1.1.0", previous: "1.0.0" }),
    ]);
    expect(installs).toEqual(["1.1.0"]);
    expect(await readState()).toEqual({
      previous: "1.0.0",
      pending: "1.1.0",
      startsSincePending: 0,
      failed: [],
      lastError: null,
      handledRequestId: null,
    });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it("never installs when not running under pm2, and reports unsupported", async () => {
    const { installs, installer } = fakeInstaller();
    const { calls, daemon } = fakeDaemon();
    const u = updater({ installer, underPm2: false });
    await u.start();
    await u.onHeartbeat(config("1.1.0"), daemon);
    expect(installs).toEqual([]);
    expect(calls).toEqual([]);
    expect(u.report().selfUpdate).toBe("unsupported");
  });

  it("records a failed install, keeps running the current version and never retries it", async () => {
    const { installs, installer } = fakeInstaller(["1.1.0"]);
    const { calls, daemon } = fakeDaemon();
    const u = updater({ installer });
    await u.start();
    await u.onHeartbeat(config("1.1.0"), daemon);
    expect(calls).toEqual([`drain ${2 * 60 * 60 * 1000}`, "resume"]);
    expect(u.report()).toEqual({
      selfUpdate: "supported",
      update: {
        state: "idle",
        version: null,
        previous: null,
        startsSincePending: 0,
        error: "Installing 1.1.0 failed: npm ERR! 404 1.1.0 not found",
      },
      failedVersions: ["1.1.0"],
      handledUpdateRequestId: null,
    });
    expect(await readState()).toMatchObject({ pending: null, failed: ["1.1.0"] });

    // Never retried, even after a restart; a newer version is.
    await u.onHeartbeat(config("1.1.0"), daemon);
    const restarted = updater({ installer });
    await restarted.start();
    await restarted.onHeartbeat(config("1.1.0"), daemon);
    expect(installs).toEqual(["1.1.0"]);
    await restarted.onHeartbeat(config("1.2.0"), daemon);
    expect(installs).toEqual(["1.1.0", "1.2.0"]);
  });

  it("gives up an update when the agent is stopped while draining", async () => {
    const { installs, installer } = fakeInstaller();
    const { calls, daemon } = fakeDaemon();
    daemon.drain = async () => {
      daemon.stopping = true;
    };
    const u = updater({ installer });
    await u.start();
    await u.onHeartbeat(config("1.1.0"), daemon);
    expect(installs).toEqual([]);
    expect(calls).toEqual([]);
    expect(u.report().update?.state).toBe("idle");
  });

  it("confirms the new version after 60s of successful heartbeats", async () => {
    await writeUpdateState(statePath, {
      previous: "1.0.0",
      pending: "1.1.0",
      startsSincePending: 0,
      failed: [],
      lastError: null,
    });
    const clock = fakeClock();
    const { daemon } = fakeDaemon();
    const u = updater({ version: "1.1.0", clock });
    expect(await u.start()).toBe("run");
    expect((await readState()).startsSincePending).toBe(1);
    expect(u.report().update).toEqual({
      state: "confirming",
      version: "1.1.0",
      previous: "1.0.0",
      startsSincePending: 1,
      error: null,
    });

    await u.onHeartbeat(config("1.1.0"), daemon);
    clock.tick(40_000);
    await u.onHeartbeat(config("1.1.0"), daemon);
    // A failed heartbeat starts the minute over.
    await u.onHeartbeat(null, daemon);
    clock.tick(20_000);
    await u.onHeartbeat(config("1.1.0"), daemon);
    clock.tick(59_999);
    await u.onHeartbeat(config("1.1.0"), daemon);
    expect((await readState()).pending).toBe("1.1.0");
    clock.tick(1);
    await u.onHeartbeat(config("1.1.0"), daemon);
    expect(await readState()).toEqual({
      previous: "1.0.0",
      pending: null,
      startsSincePending: 0,
      failed: [],
      lastError: null,
      handledRequestId: null,
    });
    expect(u.report().update?.state).toBe("idle");
  });

  it("doesn't start another update while the new version is unconfirmed", async () => {
    await writeUpdateState(statePath, {
      previous: "1.0.0",
      pending: "1.1.0",
      startsSincePending: 0,
      failed: [],
      lastError: null,
    });
    const clock = fakeClock();
    const { installs, installer } = fakeInstaller();
    const { daemon } = fakeDaemon();
    const u = updater({ version: "1.1.0", installer, clock });
    await u.start();
    await u.onHeartbeat(config("1.2.0"), daemon);
    expect(installs).toEqual([]);
    clock.tick(60_000);
    await u.onHeartbeat(config("1.2.0"), daemon);
    expect(installs).toEqual(["1.2.0"]);
  });

  it("rolls back a version that crash-loops: reinstalls the previous one and marks it failed", async () => {
    await writeUpdateState(statePath, {
      previous: "1.0.0",
      pending: "1.1.0",
      startsSincePending: 0,
      failed: ["0.9.0"],
      lastError: null,
    });
    const { installs, installer } = fakeInstaller();
    // Three starts that die before being confirmed…
    for (let start = 1; start <= 3; start++) {
      expect(await updater({ version: "1.1.0", installer }).start()).toBe("run");
      expect((await readState()).startsSincePending).toBe(start);
    }
    expect(installs).toEqual([]);
    // …and the fourth rolls back and exits, so pm2 starts 1.0.0.
    expect(await updater({ version: "1.1.0", installer }).start()).toBe("exit");
    expect(installs).toEqual(["1.0.0"]);
    expect(await readState()).toEqual({
      previous: "1.0.0",
      pending: null,
      startsSincePending: 0,
      failed: ["0.9.0", "1.1.0"],
      lastError: "1.1.0 didn't stay up after 3 starts; rolled back to 1.0.0",
      handledRequestId: null,
    });

    // The previous version starts normally, reports the failure and never retries 1.1.0.
    const { calls, daemon } = fakeDaemon();
    const back = updater({ version: "1.0.0", installer });
    expect(await back.start()).toBe("run");
    await back.onHeartbeat(config("1.1.0"), daemon);
    expect(calls).toEqual([]);
    expect(back.report()).toMatchObject({
      update: { state: "idle", error: expect.stringContaining("rolled back") },
      failedVersions: ["0.9.0", "1.1.0"],
    });
  });

  it("still marks the version failed when reinstalling the previous one fails", async () => {
    await writeUpdateState(statePath, {
      previous: "1.0.0",
      pending: "1.1.0",
      startsSincePending: 3,
      failed: [],
      lastError: null,
    });
    const { installer } = fakeInstaller(["1.0.0"]);
    expect(await updater({ version: "1.1.0", installer }).start()).toBe("exit");
    expect(await readState()).toMatchObject({
      pending: null,
      failed: ["1.1.0"],
      lastError: expect.stringContaining("reinstalling 1.0.0 failed"),
    });
  });

  it("treats a missing or corrupt state file as no update", async () => {
    expect(await readUpdateState(statePath)).toEqual({
      previous: null,
      pending: null,
      startsSincePending: 0,
      failed: [],
      lastError: null,
      handledRequestId: null,
    });
    await writeFile(statePath, "{not json");
    expect((await readUpdateState(statePath)).pending).toBeNull();
    expect(await updater().start()).toBe("run");
  });

  it("refuses a desired version that isn't semver", async () => {
    const { installs, installer } = fakeInstaller();
    const { daemon } = fakeDaemon();
    const u = updater({ installer });
    await u.start();
    await u.onHeartbeat({ ...config(null), desiredVersion: "latest; rm -rf /" }, daemon);
    expect(installs).toEqual([]);
  });

  describe("requested updates", () => {
    const REQUEST_ID = "0b6f2c1e-6a43-4b8e-9d55-3f1f0c9a7e21";
    const requested = (desired: string | null, version: string, id = REQUEST_ID) => ({
      ...config(desired),
      updateRequest: { id, version },
    });
    const exists = (file: string) =>
      access(file).then(
        () => true,
        () => false,
      );

    it("updates to the control panel's version, even one that failed, and reports the request handled", async () => {
      await writeUpdateState(statePath, {
        failed: ["1.1.0"],
        lastError: "Installing 1.1.0 failed",
      });
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      const u = updater({ installer });
      await u.start();
      // Without a request the failed version stays untried.
      await u.onHeartbeat(config("1.1.0"), daemon);
      expect(installs).toEqual([]);

      await u.onHeartbeat(requested("1.1.0", "1.1.0"), daemon);
      expect(installs).toEqual(["1.1.0"]);
      expect(calls).toEqual([`drain ${2 * 60 * 60 * 1000}`, "exit"]);
      expect(await readState()).toMatchObject({
        previous: "1.0.0",
        pending: "1.1.0",
        failed: [],
        lastError: null,
        handledRequestId: REQUEST_ID,
      });

      // The new version reports it handled and doesn't act on it again.
      const next = updater({ version: "1.1.0", installer });
      await next.start();
      expect(next.report().handledUpdateRequestId).toBe(REQUEST_ID);
      await next.onHeartbeat(requested("1.1.0", "1.1.0"), fakeDaemon().daemon);
      expect(installs).toEqual(["1.1.0"]);
    });

    it("updates when `omniralph-harness update` asks: to the desired version, else the latest on npm", async () => {
      const { installs, installer } = fakeInstaller([], "1.3.0");
      const { calls, daemon } = fakeDaemon();
      const u = updater({ installer });
      await u.start();
      await u.onHeartbeat(config(null), daemon);
      expect(installs).toEqual([]);

      await writeUpdateRequest(requestPath);
      await u.onHeartbeat(config(null), daemon);
      expect(installs).toEqual(["1.3.0"]);
      expect(calls).toEqual([`drain ${2 * 60 * 60 * 1000}`, "exit"]);
      expect(await exists(requestPath)).toBe(false);
      expect(await readState()).toMatchObject({ pending: "1.3.0", handledRequestId: null });

      // A desired version wins over npm's latest, and is retried even after failing.
      await writeUpdateState(statePath, { failed: ["1.1.0"] });
      const again = updater({ installer });
      await again.start();
      await writeUpdateRequest(requestPath);
      await again.onHeartbeat(config("1.1.0"), fakeDaemon().daemon);
      expect(installs).toEqual(["1.3.0", "1.1.0"]);
    });

    it("only reports a request when it can't update itself or already runs the version", async () => {
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      const manual = updater({ installer, underPm2: false });
      await manual.start();
      await manual.onHeartbeat(requested(null, "1.1.0"), daemon);
      await writeUpdateRequest(requestPath);
      await manual.onHeartbeat(config(null), daemon);
      expect(manual.report()).toMatchObject({
        handledUpdateRequestId: REQUEST_ID,
        update: { error: expect.stringContaining("isn't running under pm2") },
      });
      expect(await exists(requestPath)).toBe(false);

      const current = updater({ installer });
      await current.start();
      await current.onHeartbeat(
        requested(null, "1.0.0", "7d1e0f4a-2b3c-4d5e-8f90-a1b2c3d4e5f6"),
        daemon,
      );
      expect(current.report().handledUpdateRequestId).toBe("7d1e0f4a-2b3c-4d5e-8f90-a1b2c3d4e5f6");
      expect(installs).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("starts one update while heartbeats keep coming during the drain", async () => {
      const { installs, installer } = fakeInstaller();
      let release!: () => void;
      const drained = new Promise<void>((resolve) => (release = resolve));
      const { calls, daemon } = fakeDaemon();
      daemon.drain = async () => {
        calls.push("drain");
        await drained;
      };
      const u = updater({ installer });
      await u.start();
      const first = u.onHeartbeat(requested("1.1.0", "1.1.0"), daemon);
      await writeUpdateRequest(requestPath);
      await u.onHeartbeat(requested("1.1.0", "1.1.0"), daemon);
      await u.onHeartbeat(config("1.1.0"), daemon);
      release();
      await first;
      expect(calls).toEqual(["drain", "exit"]);
      expect(installs).toEqual(["1.1.0"]);
    });
  });
});

describe("npmInstaller", () => {
  afterEach(() => childProcess.execFile.mockReset());

  it("installs and looks up @omniralph/harness", async () => {
    childProcess.execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (...a: unknown[]) => void) =>
        callback(null, "1.2.3\n", ""),
    );
    const installer = npmInstaller({});
    await installer.install("1.2.3");
    expect(await installer.latest!()).toBe("1.2.3");
    expect(childProcess.execFile.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["npm", ["i", "-g", "@omniralph/harness@1.2.3"]],
      ["npm", ["view", "@omniralph/harness", "version"]],
    ]);
  });
});
