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
    pollIntervalSeconds: 5,
    pinnedRepositories: [],
    organizationId: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
    topics: [],
    queueRegion: "iad1",
    cancelJobIds: [],
    jobTokens: [],
    jobMessages: [],
    desiredVersion,
    requiredHostTools: [],
  };
}

/** Records installs; `fail` makes the next installs of those versions throw. */
function fakeInstaller(fail: string[] = [], latest = "2.2.0") {
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
    statePath = updateStatePath(path.join(dir, "agent.json"));
    requestPath = updateRequestPath(path.join(dir, "agent.json"));
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
      pin?: () => string | null;
    } = {},
  ) {
    const clock = options.clock ?? fakeClock();
    return new SelfUpdater({
      statePath,
      requestPath,
      pin: options.pin,
      runningVersion: options.version ?? "2.0.0",
      underPm2: options.underPm2 ?? true,
      installer: options.installer ?? fakeInstaller().installer,
      logger: silentLogger(),
      now: () => clock.now,
    });
  }

  const readState = async () => JSON.parse(await readFile(statePath, "utf8")) as UpdateStateFile;

  it("keeps the update state next to the agent config", () => {
    expect(updateStatePath("/home/a/.config/omniralph/agent.json")).toBe(
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
    await u.onHeartbeat(config("2.0.0"), daemon);
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
    await u.onHeartbeat(config("2.1.0"), daemon);

    expect(calls).toEqual([`drain ${2 * 60 * 60 * 1000}`, "exit"]);
    expect(reports).toEqual([
      expect.objectContaining({ state: "draining", version: "2.1.0", previous: "2.0.0" }),
    ]);
    expect(installs).toEqual(["2.1.0"]);
    expect(await readState()).toEqual({
      previous: "2.0.0",
      pending: "2.1.0",
      startsSincePending: 0,
      failed: [],
      lastError: null,
    });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it("never installs when not running under pm2, and reports unsupported", async () => {
    const { installs, installer } = fakeInstaller();
    const { calls, daemon } = fakeDaemon();
    const u = updater({ installer, underPm2: false });
    await u.start();
    await u.onHeartbeat(config("2.1.0"), daemon);
    expect(installs).toEqual([]);
    expect(calls).toEqual([]);
    expect(u.report().selfUpdate).toBe("unsupported");
  });

  it("records a failed install, keeps running the current version and never retries it", async () => {
    const { installs, installer } = fakeInstaller(["2.1.0"]);
    const { calls, daemon } = fakeDaemon();
    const u = updater({ installer });
    await u.start();
    await u.onHeartbeat(config("2.1.0"), daemon);
    expect(calls).toEqual([`drain ${2 * 60 * 60 * 1000}`, "resume"]);
    expect(u.report()).toEqual({
      selfUpdate: "supported",
      update: {
        state: "idle",
        version: null,
        previous: null,
        startsSincePending: 0,
        error: "Installing 2.1.0 failed: npm ERR! 404 2.1.0 not found",
      },
      failedVersions: ["2.1.0"],
    });
    expect(await readState()).toMatchObject({ pending: null, failed: ["2.1.0"] });

    // Never retried, even after a restart; a newer version is.
    await u.onHeartbeat(config("2.1.0"), daemon);
    const restarted = updater({ installer });
    await restarted.start();
    await restarted.onHeartbeat(config("2.1.0"), daemon);
    expect(installs).toEqual(["2.1.0"]);
    await restarted.onHeartbeat(config("2.2.0"), daemon);
    expect(installs).toEqual(["2.1.0", "2.2.0"]);
  });

  it("gives up an update when the agent is stopped while draining", async () => {
    const { installs, installer } = fakeInstaller();
    const { calls, daemon } = fakeDaemon();
    daemon.drain = async () => {
      daemon.stopping = true;
    };
    const u = updater({ installer });
    await u.start();
    await u.onHeartbeat(config("2.1.0"), daemon);
    expect(installs).toEqual([]);
    expect(calls).toEqual([]);
    expect(u.report().update?.state).toBe("idle");
  });

  it("confirms the new version after 60s of successful heartbeats", async () => {
    await writeUpdateState(statePath, {
      previous: "2.0.0",
      pending: "2.1.0",
      startsSincePending: 0,
      failed: [],
      lastError: null,
    });
    const clock = fakeClock();
    const { daemon } = fakeDaemon();
    const u = updater({ version: "2.1.0", clock });
    expect(await u.start()).toBe("run");
    expect((await readState()).startsSincePending).toBe(1);
    expect(u.report().update).toEqual({
      state: "confirming",
      version: "2.1.0",
      previous: "2.0.0",
      startsSincePending: 1,
      error: null,
    });

    await u.onHeartbeat(config("2.1.0"), daemon);
    clock.tick(40_000);
    await u.onHeartbeat(config("2.1.0"), daemon);
    // A failed heartbeat starts the minute over.
    await u.onHeartbeat(null, daemon);
    clock.tick(20_000);
    await u.onHeartbeat(config("2.1.0"), daemon);
    clock.tick(59_999);
    await u.onHeartbeat(config("2.1.0"), daemon);
    expect((await readState()).pending).toBe("2.1.0");
    clock.tick(1);
    await u.onHeartbeat(config("2.1.0"), daemon);
    expect(await readState()).toEqual({
      previous: "2.0.0",
      pending: null,
      startsSincePending: 0,
      failed: [],
      lastError: null,
    });
    expect(u.report().update?.state).toBe("idle");
  });

  it("doesn't start another update while the new version is unconfirmed", async () => {
    await writeUpdateState(statePath, {
      previous: "2.0.0",
      pending: "2.1.0",
      startsSincePending: 0,
      failed: [],
      lastError: null,
    });
    const clock = fakeClock();
    const { installs, installer } = fakeInstaller();
    const { daemon } = fakeDaemon();
    const u = updater({ version: "2.1.0", installer, clock });
    await u.start();
    await u.onHeartbeat(config("2.2.0"), daemon);
    expect(installs).toEqual([]);
    clock.tick(60_000);
    await u.onHeartbeat(config("2.2.0"), daemon);
    expect(installs).toEqual(["2.2.0"]);
  });

  it("rolls back a version that crash-loops: reinstalls the previous one and marks it failed", async () => {
    await writeUpdateState(statePath, {
      previous: "2.0.0",
      pending: "2.1.0",
      startsSincePending: 0,
      failed: ["1.9.0"],
      lastError: null,
    });
    const { installs, installer } = fakeInstaller();
    // Three starts that die before being confirmed…
    for (let start = 1; start <= 3; start++) {
      expect(await updater({ version: "2.1.0", installer }).start()).toBe("run");
      expect((await readState()).startsSincePending).toBe(start);
    }
    expect(installs).toEqual([]);
    // …and the fourth rolls back and exits, so pm2 starts 2.0.0.
    expect(await updater({ version: "2.1.0", installer }).start()).toBe("exit");
    expect(installs).toEqual(["2.0.0"]);
    expect(await readState()).toEqual({
      previous: "2.0.0",
      pending: null,
      startsSincePending: 0,
      failed: ["1.9.0", "2.1.0"],
      lastError: "2.1.0 didn't stay up after 3 starts; rolled back to 2.0.0",
    });

    // The previous version starts normally, reports the failure and never retries 2.1.0.
    const { calls, daemon } = fakeDaemon();
    const back = updater({ version: "2.0.0", installer });
    expect(await back.start()).toBe("run");
    await back.onHeartbeat(config("2.1.0"), daemon);
    expect(calls).toEqual([]);
    expect(back.report()).toMatchObject({
      update: { state: "idle", error: expect.stringContaining("rolled back") },
      failedVersions: ["1.9.0", "2.1.0"],
    });
  });

  it("still marks the version failed when reinstalling the previous one fails", async () => {
    await writeUpdateState(statePath, {
      previous: "2.0.0",
      pending: "2.1.0",
      startsSincePending: 3,
      failed: [],
      lastError: null,
    });
    const { installer } = fakeInstaller(["2.0.0"]);
    expect(await updater({ version: "2.1.0", installer }).start()).toBe("exit");
    expect(await readState()).toMatchObject({
      pending: null,
      failed: ["2.1.0"],
      lastError: expect.stringContaining("reinstalling 2.0.0 failed"),
    });
  });

  it("treats a missing or corrupt state file as no update", async () => {
    expect(await readUpdateState(statePath)).toEqual({
      previous: null,
      pending: null,
      startsSincePending: 0,
      failed: [],
      lastError: null,
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

  it("refuses a desired version below @omniralph/agent 2.0.0 and says why", async () => {
    const { installs, installer } = fakeInstaller();
    const { calls, daemon } = fakeDaemon();
    const u = updater({ installer });
    await u.start();
    for (const old of ["0.8.0", "1.9.9"]) {
      await u.onHeartbeat(config(old), daemon);
      await u.onHeartbeat(config(old), daemon);
      expect(installs).toEqual([]);
      expect(calls).toEqual([]);
      expect(await readState()).toMatchObject({
        pending: null,
        failed: [],
        lastError: `Version ${old} is older than @omniralph/agent 2.0.0`,
      });
      expect(u.report().update?.error).toBe(`Version ${old} is older than @omniralph/agent 2.0.0`);
    }

    // 2.0.0 itself is fine.
    await u.onHeartbeat(config("2.0.0"), daemon);
    expect(installs).toEqual([]);
    await u.onHeartbeat(config("2.1.0"), daemon);
    expect(installs).toEqual(["2.1.0"]);
    expect(await readState()).toMatchObject({ pending: "2.1.0", lastError: null });
  });

  describe("the target", () => {
    it("is the pin over the organization's version, and none without either", async () => {
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      let pin: string | null = "2.0.3";
      const u = updater({ installer, pin: () => pin });
      await u.start();
      await u.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual(["2.0.3"]);

      // Pinned to the running version: the organization's newer one isn't installed.
      await writeUpdateState(statePath, {});
      const pinnedHere = updater({ version: "2.0.3", installer, pin: () => pin });
      await pinnedHere.start();
      await pinnedHere.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual(["2.0.3"]);

      // No pin: the organization's version.
      pin = null;
      await pinnedHere.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual(["2.0.3", "2.0.4"]);

      // Neither: nothing.
      const unmanaged = updater({ version: "2.0.3", installer, pin: () => null });
      await unmanaged.start();
      await unmanaged.onHeartbeat(config(null), fakeDaemon().daemon);
      expect(installs).toEqual(["2.0.3", "2.0.4"]);
      expect(calls).toEqual([
        `drain ${2 * 60 * 60 * 1000}`,
        "exit",
        `drain ${2 * 60 * 60 * 1000}`,
        "exit",
      ]);
    });

    it("skips a failed pin without falling back to the organization's version", async () => {
      await writeUpdateState(statePath, { failed: ["2.0.3"] });
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      const u = updater({ installer, pin: () => "2.0.3" });
      await u.start();
      await u.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("re-evaluates after the drain when the pin changes meanwhile", async () => {
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      let pin: string | null = "2.0.3";
      daemon.drain = async () => {
        calls.push("drain");
        pin = "2.0.5";
      };
      const u = updater({ installer, pin: () => pin });
      await u.start();
      await u.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual(["2.0.5"]);
      expect(calls).toEqual(["drain", "exit"]);
      expect(await readState()).toMatchObject({ pending: "2.0.5" });
    });

    it("resumes without installing when the pin changes to the running version during the drain", async () => {
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      let pin: string | null = "2.0.3";
      daemon.drain = async () => {
        calls.push("drain");
        pin = "2.0.0";
      };
      const u = updater({ installer, pin: () => pin });
      await u.start();
      await u.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual([]);
      expect(calls).toEqual(["drain", "resume"]);
      expect(u.report().update).toMatchObject({ state: "idle", version: null });

      // Unpinned during a later drain: the organization's version is installed instead.
      pin = "2.0.3";
      daemon.drain = async () => {
        calls.push("drain");
        pin = null;
      };
      await u.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual(["2.0.4"]);
    });

    it("follows the organization's version as the latest heartbeat says during the drain", async () => {
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
      const first = u.onHeartbeat(config("2.1.0"), daemon);
      await u.onHeartbeat(config("2.1.1"), daemon);
      release();
      await first;
      expect(calls).toEqual(["drain", "exit"]);
      expect(installs).toEqual(["2.1.1"]);
    });
  });

  describe("Update now", () => {
    const exists = (file: string) =>
      access(file).then(
        () => true,
        () => false,
      );

    it("comes to request() the same way from the page and from `omniralph-agent update`", async () => {
      const at = new Date("2026-10-28T10:42:00.000Z");
      const clock = fakeClock(at.getTime());
      const fromPage = updater({ clock });
      await fromPage.start();
      const asked = fromPage.request();

      const fromCli = updater({ clock, underPm2: false });
      await fromCli.start();
      const request = vi.spyOn(fromCli, "request");
      await writeUpdateRequest(requestPath, at);
      await fromCli.onHeartbeat(config(null), fakeDaemon().daemon);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.results[0]!.value).toEqual(asked);
      expect(asked).toEqual({ version: null, requestedAt: at.toISOString() });
      expect(fromPage.pendingRequest()).toEqual(asked);
      // Taken by the heartbeat.
      expect(fromCli.pendingRequest()).toBeNull();
    });

    it("updates at once to the pin, even one that failed", async () => {
      await writeUpdateState(statePath, {
        failed: ["2.0.3"],
        lastError: "Installing 2.0.3 failed",
      });
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      const u = updater({ installer, pin: () => "2.0.3" });
      await u.start();
      // Without a request the failed pin stays untried.
      await u.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual([]);

      u.request();
      await u.onHeartbeat(config("2.0.4"), daemon);
      expect(installs).toEqual(["2.0.3"]);
      expect(calls).toEqual([`drain ${2 * 60 * 60 * 1000}`, "exit"]);
      expect(await readState()).toMatchObject({
        previous: "2.0.0",
        pending: "2.0.3",
        failed: [],
        lastError: null,
      });
      expect(u.pendingRequest()).toBeNull();
    });

    it("updates to a requested version over the pin", async () => {
      const { installs, installer } = fakeInstaller();
      const u = updater({ installer, pin: () => "2.0.3" });
      await u.start();
      u.request({ version: "2.0.6" });
      await u.onHeartbeat(config("2.0.4"), fakeDaemon().daemon);
      expect(installs).toEqual(["2.0.6"]);
    });

    it("updates to the organization's version, else the latest on npm", async () => {
      const { installs, installer } = fakeInstaller([], "2.3.0");
      const { calls, daemon } = fakeDaemon();
      const u = updater({ installer });
      await u.start();
      await u.onHeartbeat(config(null), daemon);
      expect(installs).toEqual([]);

      await writeUpdateRequest(requestPath);
      await u.onHeartbeat(config(null), daemon);
      expect(installs).toEqual(["2.3.0"]);
      expect(calls).toEqual([`drain ${2 * 60 * 60 * 1000}`, "exit"]);
      expect(await exists(requestPath)).toBe(false);
      expect(await readState()).toMatchObject({ pending: "2.3.0" });

      // The organization's version wins over npm's latest, and is retried even after failing.
      await writeUpdateState(statePath, { failed: ["2.1.0"] });
      const again = updater({ installer });
      await again.start();
      await writeUpdateRequest(requestPath);
      await again.onHeartbeat(config("2.1.0"), fakeDaemon().daemon);
      expect(installs).toEqual(["2.3.0", "2.1.0"]);
    });

    it("follows a pin changed during the drain", async () => {
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      let pin: string | null = "2.0.3";
      daemon.drain = async () => {
        calls.push("drain");
        pin = "2.0.5";
      };
      const u = updater({ installer, pin: () => pin });
      await u.start();
      u.request();
      await u.onHeartbeat(config(null), daemon);
      expect(installs).toEqual(["2.0.5"]);
      expect(calls).toEqual(["drain", "exit"]);
    });

    it("only says why when it can't update itself or already runs the version", async () => {
      const { installs, installer } = fakeInstaller();
      const { calls, daemon } = fakeDaemon();
      const manual = updater({ installer, underPm2: false });
      await manual.start();
      await writeUpdateRequest(requestPath);
      await manual.onHeartbeat(config(null), daemon);
      expect(manual.report()).toMatchObject({
        update: { error: expect.stringContaining("isn't running under pm2") },
      });
      expect(await exists(requestPath)).toBe(false);

      const current = updater({ installer, pin: () => "2.0.0" });
      await current.start();
      current.request();
      await current.onHeartbeat(config("2.0.4"), daemon);
      expect(current.pendingRequest()).toBeNull();
      expect(installs).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("refuses a requested version below @omniralph/agent 2.0.0", async () => {
      const { installs, installer } = fakeInstaller([], "0.8.0");
      const { calls, daemon } = fakeDaemon();
      const u = updater({ installer });
      await u.start();

      u.request({ version: "1.9.9" });
      await u.onHeartbeat(config("2.1.0"), daemon);
      expect(installs).toEqual([]);
      expect(await readState()).toMatchObject({
        pending: null,
        lastError: "Version 1.9.9 is older than @omniralph/agent 2.0.0",
      });

      // `omniralph-agent update` with npm's latest still on the deprecated 0.8.0.
      await writeUpdateRequest(requestPath);
      await u.onHeartbeat(config(null), daemon);
      expect(installs).toEqual([]);
      expect(calls).toEqual([]);
      expect(await exists(requestPath)).toBe(false);
      expect(await readState()).toMatchObject({
        pending: null,
        lastError: "Version 0.8.0 is older than @omniralph/agent 2.0.0",
      });
    });

    it("starts one update while heartbeats and requests keep coming during the drain", async () => {
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
      u.request();
      const first = u.onHeartbeat(config("2.1.0"), daemon);
      await writeUpdateRequest(requestPath);
      u.request();
      await u.onHeartbeat(config("2.1.0"), daemon);
      release();
      await first;
      expect(calls).toEqual(["drain", "exit"]);
      expect(installs).toEqual(["2.1.0"]);
    });
  });
});

describe("npmInstaller", () => {
  afterEach(() => childProcess.execFile.mockReset());

  it("installs and looks up @omniralph/agent", async () => {
    childProcess.execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (...a: unknown[]) => void) =>
        callback(null, "2.2.3\n", ""),
    );
    const installer = npmInstaller({});
    await installer.install("2.2.3");
    expect(await installer.latest!()).toBe("2.2.3");
    expect(childProcess.execFile.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["npm", ["i", "-g", "@omniralph/agent@2.2.3"]],
      ["npm", ["view", "@omniralph/agent", "version"]],
    ]);
  });
});
