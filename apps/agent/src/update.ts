/**
 * Self-update under pm2: when the heartbeat's `desiredVersion` differs from
 * the running one, the agent drains (no new jobs, running ones get up to 2h),
 * runs `npm i -g @omniralph/agent@<version>`, records the
 * update in `update-state.json` next to its config and exits; pm2 starts the
 * new version. A version that keeps dying on start (more than 3 starts before
 * staying up for 60s) is rolled back to the previous one and never tried
 * again. Hosts not under pm2 report `unsupported` and never install anything.
 *
 * An update can also be asked for: by an admin's "Update now" (the heartbeat's
 * `updateRequest`) or by `omniralph-agent update` on the host (an
 * `update-request.json` next to the config). The agent then updates at once,
 * to the requested version, else the desired one, else the latest on npm, and
 * retries it even if it failed before.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PACKAGE,
  AgentVersion,
  type AgentUpdateReport,
  type AgentUpdateRequest,
  type AgentUpdateStateName,
  type Heartbeat,
  type HeartbeatResponse,
  type SelfUpdateSupport,
} from "@omniralph/shared";
import { z } from "zod";
import { writePrivateJson } from "./config.js";
import type { Logger } from "./logger.js";

export const UPDATE_STATE_FILE = "update-state.json";
export const UPDATE_REQUEST_FILE = "update-request.json";
/** A pending version is rolled back once it has started more often than this without being confirmed. */
export const MAX_STARTS_SINCE_PENDING = 3;
/** How long a new version must heartbeat successfully before it's kept. */
export const CONFIRM_AFTER_MS = 60_000;
/** How long the drain waits for running jobs before aborting them (they're redelivered). */
export const DRAIN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Longest `npm i -g` may take. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/** Failed versions remembered (the heartbeat reports at most 100). */
const FAILED_VERSIONS_KEPT = 100;

/** `update-state.json`: the rollback target, the unconfirmed version and the versions never to retry. */
export const UpdateStateFile = z.object({
  /** The version running before the last update (the rollback target). */
  previous: z.string().nullable().default(null),
  /** The version installed by the last update, until it's confirmed. */
  pending: z.string().nullable().default(null),
  /** Starts of `pending` so far. */
  startsSincePending: z.int().min(0).default(0),
  failed: z.array(z.string()).default([]),
  /** Why the last update or rollback failed. */
  lastError: z.string().nullable().default(null),
  /** The control panel's last `updateRequest` acted on (reported back so it's cleared). */
  handledRequestId: z.string().nullable().default(null),
});
export type UpdateStateFile = z.infer<typeof UpdateStateFile>;

function emptyState(): UpdateStateFile {
  return {
    previous: null,
    pending: null,
    startsSincePending: 0,
    failed: [],
    lastError: null,
    handledRequestId: null,
  };
}

/** `update-state.json` in the agent config's directory. */
export function updateStatePath(configPath: string): string {
  return path.join(path.dirname(configPath), UPDATE_STATE_FILE);
}

/** `update-request.json` in the agent config's directory (written by `omniralph-agent update`). */
export function updateRequestPath(configPath: string): string {
  return path.join(path.dirname(configPath), UPDATE_REQUEST_FILE);
}

/** `update-request.json`: an update asked for on the host. */
export const LocalUpdateRequest = z.object({
  id: z.string(),
  requestedAt: z.string(),
});
export type LocalUpdateRequest = z.infer<typeof LocalUpdateRequest>;

/** Asks the running agent to update with its next heartbeat (replacing an earlier request). */
export async function writeUpdateRequest(
  file: string,
  now: Date = new Date(),
): Promise<LocalUpdateRequest> {
  const request = { id: randomUUID(), requestedAt: now.toISOString() };
  await writePrivateJson(file, request);
  return request;
}

/** The update asked for on the host, or null (none, or unreadable: it's then removed). */
async function readUpdateRequest(file: string): Promise<LocalUpdateRequest | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = LocalUpdateRequest.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  await rm(file, { force: true });
  return null;
}

/** Reads the update state; a missing or unreadable file is an empty state. */
export async function readUpdateState(file: string): Promise<UpdateStateFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  try {
    const parsed = UpdateStateFile.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  return emptyState();
}

/** Writes the update state atomically, readable by the owner only (0600). */
export function writeUpdateState(
  file: string,
  state: z.input<typeof UpdateStateFile>,
): Promise<void> {
  return writePrivateJson(file, state);
}

/** Installs a version of the agent package (globally, for pm2 to start). */
export interface Installer {
  install(version: string): Promise<void>;
  /** The package's `latest` version on npm (for requested updates without a desired version). */
  latest?(): Promise<string>;
}

/** `npm i -g @omniralph/agent@<version>` (a public package: no npm auth needed). */
export function npmInstaller(env: NodeJS.ProcessEnv = process.env): Installer {
  return {
    latest: () =>
      new Promise((resolve, reject) => {
        execFile(
          "npm",
          ["view", AGENT_PACKAGE, "version"],
          { env, timeout: 60_000 },
          (error, stdout, stderr) => {
            if (!error) return resolve(String(stdout).trim());
            const tail = String(stderr).trim().split("\n").slice(-5).join("\n");
            reject(
              new Error(`npm view ${AGENT_PACKAGE} version failed: ${tail || error.message}`),
            );
          },
        );
      }),
    install: (version) =>
      new Promise((resolve, reject) => {
        execFile(
          "npm",
          ["i", "-g", `${AGENT_PACKAGE}@${version}`],
          { env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
          (error, _stdout, stderr) => {
            if (!error) return resolve();
            const tail = String(stderr).trim().split("\n").slice(-5).join("\n");
            reject(
              new Error(`npm i -g ${AGENT_PACKAGE}@${version} failed: ${tail || error.message}`),
            );
          },
        );
      }),
  };
}

/** True when pm2 runs this process (it sets `pm_id`), so an exit restarts it. */
export function runningUnderPm2(env: NodeJS.ProcessEnv): boolean {
  return env.pm_id !== undefined && env.pm_id !== "";
}

/** What the updater needs from the daemon. */
export interface DrainableDaemon {
  /**
   * Stops receiving and waits up to `timeoutMs` for running jobs, then
   * aborts the rest (they're redelivered). Resolves once nothing runs.
   */
  drain(timeoutMs: number): Promise<void>;
  /** Receives again after a drain (the update failed). */
  resume(): void;
  /** Exits with code 0 so pm2 restarts the agent (into the new version). */
  exitForUpdate(): void;
  /** True once the daemon is stopping (SIGTERM, fatal error). */
  isStopping(): boolean;
}

export interface SelfUpdaterOptions {
  statePath: string;
  /** `update-request.json`, checked with every heartbeat (none: only the control panel asks). */
  requestPath?: string;
  runningVersion: string;
  /** Running under pm2: only then does the agent update itself. */
  underPm2: boolean;
  installer: Installer;
  logger: Logger;
  /** Clock (ms since epoch), for tests. */
  now?: () => number;
  drainTimeoutMs?: number;
  confirmAfterMs?: number;
}

export class SelfUpdater {
  private state: UpdateStateFile = emptyState();
  private phase: AgentUpdateStateName = "idle";
  /** The version being drained for or installed. */
  private target: string | null = null;
  /** Start of the current run of successful heartbeats while confirming. */
  private okSince: number | null = null;
  /** A heartbeat is being handled (they're not awaited, so the next may come meanwhile). */
  private busy = false;
  private readonly now: () => number;
  private readonly drainTimeoutMs: number;
  private readonly confirmAfterMs: number;

  constructor(private readonly options: SelfUpdaterOptions) {
    this.now = options.now ?? Date.now;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    this.confirmAfterMs = options.confirmAfterMs ?? CONFIRM_AFTER_MS;
  }

  get support(): SelfUpdateSupport {
    return this.options.underPm2 ? "supported" : "unsupported";
  }

  /**
   * Runs once before the daemon starts. With a pending (unconfirmed) version
   * it counts the start; past `MAX_STARTS_SINCE_PENDING` it reinstalls the
   * previous version, marks the pending one failed and returns `exit` (pm2
   * then starts the previous version).
   */
  async start(): Promise<"run" | "exit"> {
    this.state = await readUpdateState(this.options.statePath);
    const { pending } = this.state;
    if (!pending) return "run";
    const log = this.options.logger;
    this.state.startsSincePending += 1;
    if (this.state.startsSincePending <= MAX_STARTS_SINCE_PENDING) {
      await this.save();
      this.phase = "confirming";
      log.info(
        { version: pending, starts: this.state.startsSincePending },
        "running a new version; keeping it once it has been up for a minute",
      );
      return "run";
    }

    const previous = this.state.previous;
    this.markFailed(pending);
    this.state.pending = null;
    this.state.startsSincePending = 0;
    this.state.lastError = `${pending} didn't stay up after ${MAX_STARTS_SINCE_PENDING} starts; rolled back${previous ? ` to ${previous}` : ""}`;
    log.error({ version: pending, previous }, "the new version keeps failing; rolling back");
    if (previous && previous !== this.options.runningVersion) {
      try {
        await this.options.installer.install(previous);
      } catch (error) {
        this.state.lastError = `${pending} didn't stay up, and reinstalling ${previous} failed: ${errorMessage(error)}`;
        log.error({ err: error, previous }, "reinstalling the previous version failed");
      }
    }
    await this.save();
    return "exit";
  }

  /** The self-update fields of the next heartbeat. */
  report(): Pick<Heartbeat, "selfUpdate" | "update" | "failedVersions" | "handledUpdateRequestId"> {
    const confirming = this.phase === "confirming";
    const updating = this.phase === "draining" || this.phase === "installing";
    const update: AgentUpdateReport = {
      state: this.phase,
      version: confirming ? this.state.pending : this.target,
      previous: confirming ? this.state.previous : updating ? this.options.runningVersion : null,
      startsSincePending: this.state.startsSincePending,
      error: this.state.lastError,
    };
    return {
      selfUpdate: this.support,
      update,
      failedVersions: this.state.failed.slice(-FAILED_VERSIONS_KEPT),
      handledUpdateRequestId: this.state.handledRequestId,
    };
  }

  /**
   * Called after every heartbeat: `null` when it failed. Confirms a pending
   * version after `confirmAfterMs` of successful heartbeats, then starts an
   * update when one was asked for or the desired version calls for one.
   */
  async onHeartbeat(response: HeartbeatResponse | null, daemon: DrainableDaemon): Promise<void> {
    if (!response) {
      this.okSince = null;
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.phase === "confirming") {
        this.okSince ??= this.now();
        if (this.now() - this.okSince < this.confirmAfterMs) return;
        await this.confirm();
      }
      if (this.phase !== "idle") return;
      if (await this.onRequest(response, daemon)) return;
      const version = this.wantedVersion(response.desiredVersion);
      if (version) await this.update(version, daemon);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Acts on an update the control panel or the host asked for; false when
   * none was. The request is handled (reported, or its file removed) before
   * anything is installed, so a failing one isn't retried.
   */
  private async onRequest(response: HeartbeatResponse, daemon: DrainableDaemon): Promise<boolean> {
    const fromPanel: AgentUpdateRequest | null =
      response.updateRequest && response.updateRequest.id !== this.state.handledRequestId
        ? response.updateRequest
        : null;
    const local =
      !fromPanel && this.options.requestPath
        ? await readUpdateRequest(this.options.requestPath)
        : null;
    if (!fromPanel && !local) return false;

    const log = this.options.logger;
    if (fromPanel) this.state.handledRequestId = fromPanel.id;
    else await rm(this.options.requestPath!, { force: true });
    const source = fromPanel ? "the control panel" : "omniralph-agent update";

    if (!this.options.underPm2) {
      this.state.lastError = `An update was requested (${source}), but this agent isn't running under pm2, so it can't update itself`;
      log.warn({ source }, "an update was requested, but only agents under pm2 update themselves");
      await this.save();
      return true;
    }
    let version = fromPanel?.version ?? response.desiredVersion;
    if (!version) {
      try {
        if (!this.options.installer.latest) throw new Error("no way to look it up");
        version = await this.options.installer.latest();
      } catch (error) {
        this.state.lastError = `An update was requested, but reading the latest version failed: ${errorMessage(error)}`;
        log.error(
          { err: error, source },
          "reading the latest version for a requested update failed",
        );
        await this.save();
        return true;
      }
    }
    if (!AgentVersion.safeParse(version).success) {
      this.state.lastError = `An update was requested, but ${JSON.stringify(version.slice(0, 64))} isn't a version`;
      await this.save();
      return true;
    }
    if (version === this.options.runningVersion) {
      log.info({ version, source }, "an update was requested; already running that version");
      await this.save();
      return true;
    }
    // Asked for explicitly: try it even if it failed before.
    this.state.failed = this.state.failed.filter((failed) => failed !== version);
    this.state.lastError = null;
    await this.save();
    log.info({ version, source }, "an update was requested");
    await this.update(version, daemon);
    return true;
  }

  /** The version to update to now, or null. */
  private wantedVersion(desired: string | null): string | null {
    if (!this.options.underPm2 || this.phase !== "idle" || !desired) return null;
    if (desired === this.options.runningVersion) return null;
    if (this.state.failed.includes(desired)) return null;
    // The protocol validates it already; never hand npm anything but a version.
    return AgentVersion.safeParse(desired).success ? desired : null;
  }

  private async confirm(): Promise<void> {
    const version = this.state.pending;
    this.state.pending = null;
    this.state.startsSincePending = 0;
    this.state.lastError = null;
    this.phase = "idle";
    this.okSince = null;
    await this.save();
    this.options.logger.info({ version }, "the new version is up and running; keeping it");
  }

  private async update(version: string, daemon: DrainableDaemon): Promise<void> {
    const log = this.options.logger;
    this.phase = "draining";
    this.target = version;
    log.info(
      { from: this.options.runningVersion, to: version },
      "updating: taking no new jobs and waiting for the running ones",
    );
    await daemon.drain(this.drainTimeoutMs);
    if (daemon.isStopping()) {
      this.phase = "idle";
      this.target = null;
      return;
    }
    this.phase = "installing";
    log.info({ version }, "installing the new version");
    try {
      await this.options.installer.install(version);
    } catch (error) {
      log.error({ err: error, version }, "installing the new version failed; staying on this one");
      this.markFailed(version);
      this.state.lastError = `Installing ${version} failed: ${errorMessage(error)}`;
      this.phase = "idle";
      this.target = null;
      await this.save().catch((err: unknown) =>
        log.error({ err }, "writing the update state failed"),
      );
      daemon.resume();
      return;
    }
    this.state = {
      ...this.state,
      previous: this.options.runningVersion,
      pending: version,
      startsSincePending: 0,
      lastError: null,
    };
    await this.save();
    log.info({ version }, "installed; exiting so pm2 restarts the agent on the new version");
    daemon.exitForUpdate();
  }

  private markFailed(version: string): void {
    if (!this.state.failed.includes(version)) this.state.failed.push(version);
    this.state.failed = this.state.failed.slice(-FAILED_VERSIONS_KEPT);
  }

  private save(): Promise<void> {
    return writeUpdateState(this.options.statePath, this.state);
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
