/**
 * Self-update under pm2: when the heartbeat's `desiredVersion` differs from
 * the running one, the agent drains (no new jobs, running ones get up to 2h),
 * runs `npm i -g @omniralph/agent@<version>`, records the
 * update in `update-state.json` next to its config and exits; pm2 starts the
 * new version. A version that keeps dying on start (more than 3 starts before
 * staying up for 60s) is rolled back to the previous one and never tried
 * again. Hosts not under pm2 report `unsupported` and never install anything.
 *
 * The target, highest first:
 * 1. "Update now" on the machine (`SelfUpdater.request()`: the agent's page, or
 *    `omniralph-agent update`, which writes `update-request.json` next to the
 *    config): at once, to the requested version, else the pin, else the
 *    organization's, else the latest on npm, even if it failed before;
 * 2. the local pin (`settings.json` `update.pin`);
 * 3. the organization's policy (the heartbeat's `desiredVersion`);
 * 4. none: the agent stays on its version.
 * Failed versions are skipped except by a request.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_MIN_VERSION,
  AGENT_PACKAGE,
  AgentVersion,
  agentVersionAtLeast,
  type AgentUpdateReport,
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
});
export type UpdateStateFile = z.infer<typeof UpdateStateFile>;

function emptyState(): UpdateStateFile {
  return {
    previous: null,
    pending: null,
    startsSincePending: 0,
    failed: [],
    lastError: null,
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

/**
 * `omniralph-agent update`: asks the running agent to update with its next heartbeat
 * (replacing an earlier request). The agent hands it to `SelfUpdater.request()`.
 */
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
            reject(new Error(`npm view ${AGENT_PACKAGE} version failed: ${tail || error.message}`));
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

/** "Update now": a pending local request (`SelfUpdater.request()`). */
export interface UpdateRequest {
  /** The version asked for; null: the pin, else the organization's, else the latest on npm. */
  version: string | null;
  requestedAt: string;
}

export interface SelfUpdaterOptions {
  statePath: string;
  /** `update-request.json` (`omniralph-agent update`), checked with every heartbeat. */
  requestPath?: string;
  /** The version pinned on the agent (`settings.json` `update.pin`), read at every decision. */
  pin?: () => string | null;
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

/**
 * Emits `change` whenever what `report()` or `pendingRequest()` answers may have changed
 * (a request, a phase, a saved state), for the agent page's `update` events.
 */
export class SelfUpdater extends EventEmitter<{ change: [] }> {
  private state: UpdateStateFile = emptyState();
  private phase: AgentUpdateStateName = "idle";
  /** The version being drained for or installed. */
  private target: string | null = null;
  /** Start of the current run of successful heartbeats while confirming. */
  private okSince: number | null = null;
  /** A heartbeat is being handled (they're not awaited, so the next may come meanwhile). */
  private busy = false;
  /** "Update now", until a heartbeat acts on it. */
  private pending: UpdateRequest | null = null;
  /** The organization's version from the last heartbeat. */
  private desired: string | null = null;
  private readonly now: () => number;
  private readonly drainTimeoutMs: number;
  private readonly confirmAfterMs: number;

  constructor(private readonly options: SelfUpdaterOptions) {
    super();
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
  report(): Pick<Heartbeat, "selfUpdate" | "update" | "failedVersions"> {
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
    };
  }

  /**
   * "Update now", the one entry point for it (the agent's page, and
   * `omniralph-agent update` through `update-request.json`): the next heartbeat
   * updates at once, replacing an earlier request not acted on yet.
   */
  request(options: { version?: string | null; at?: Date } = {}): UpdateRequest {
    this.pending = {
      version: options.version ?? null,
      requestedAt: (options.at ?? new Date(this.now())).toISOString(),
    };
    this.changed();
    return { ...this.pending };
  }

  /** The "Update now" not acted on yet, or null. */
  pendingRequest(): UpdateRequest | null {
    return this.pending ? { ...this.pending } : null;
  }

  /** The version the agent should run without a request: the pin, else the organization's. */
  private targetVersion(): string | null {
    return this.options.pin?.() ?? this.desired;
  }

  /**
   * Called after every heartbeat: `null` when it failed. Confirms a pending
   * version after `confirmAfterMs` of successful heartbeats, then starts an
   * update when one was asked for or the pin or the organization's version
   * calls for one.
   */
  async onHeartbeat(response: HeartbeatResponse | null, daemon: DrainableDaemon): Promise<void> {
    if (!response) {
      this.okSince = null;
      return;
    }
    this.desired = response.desiredVersion;
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.phase === "confirming") {
        this.okSince ??= this.now();
        if (this.now() - this.okSince < this.confirmAfterMs) return;
        await this.confirm();
      }
      if (this.phase !== "idle") return;
      if (await this.onRequest(daemon)) return;
      const version = this.wantedVersion(this.targetVersion());
      if (version && !(await this.refuseTooOld(version))) {
        await this.update(version, daemon, () => this.wantedVersion(this.targetVersion()));
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Acts on "Update now"; false when none is pending. The request is taken
   * (and `update-request.json` removed) before anything is installed, so a
   * failing one isn't retried.
   */
  private async onRequest(daemon: DrainableDaemon): Promise<boolean> {
    if (this.options.requestPath) {
      const file = await readUpdateRequest(this.options.requestPath);
      if (file) {
        await rm(this.options.requestPath, { force: true });
        const at = new Date(file.requestedAt);
        this.request({ at: Number.isNaN(at.getTime()) ? undefined : at });
      }
    }
    const request = this.pending;
    if (!request) return false;
    this.pending = null;
    this.changed();

    const log = this.options.logger;
    if (!this.options.underPm2) {
      this.state.lastError = `An update was requested, but this agent isn't running under pm2, so it can't update itself`;
      log.warn("an update was requested, but only agents under pm2 update themselves");
      await this.save();
      return true;
    }
    let version = request.version ?? this.targetVersion();
    if (!version) {
      try {
        if (!this.options.installer.latest) throw new Error("no way to look it up");
        version = await this.options.installer.latest();
      } catch (error) {
        this.state.lastError = `An update was requested, but reading the latest version failed: ${errorMessage(error)}`;
        log.error({ err: error }, "reading the latest version for a requested update failed");
        await this.save();
        return true;
      }
    }
    if (!AgentVersion.safeParse(version).success) {
      this.state.lastError = `An update was requested, but ${JSON.stringify(version.slice(0, 64))} isn't a version`;
      await this.save();
      return true;
    }
    if (await this.refuseTooOld(version)) return true;
    if (version === this.options.runningVersion) {
      log.info({ version }, "an update was requested; already running that version");
      await this.save();
      return true;
    }
    // Asked for explicitly: try it even if it failed before.
    this.state.failed = this.state.failed.filter((failed) => failed !== version);
    this.state.lastError = null;
    await this.save();
    log.info({ version }, "an update was requested");
    // After the drain: the version asked for, else the pin or the organization's then.
    const resolved = version;
    await this.update(version, daemon, () => {
      const next = request.version ?? this.targetVersion() ?? resolved;
      if (!AgentVersion.safeParse(next).success) return null;
      this.state.failed = this.state.failed.filter((failed) => failed !== next);
      return next;
    });
    return true;
  }

  /** The version to update to without a request, or null. */
  private wantedVersion(desired: string | null): string | null {
    if (!this.options.underPm2 || !desired) return null;
    if (desired === this.options.runningVersion) return null;
    if (this.state.failed.includes(desired)) return null;
    // The protocol validates it already; never hand npm anything but a version.
    return AgentVersion.safeParse(desired).success ? desired : null;
  }

  /**
   * True (and `lastError` says why) for a version below `AGENT_MIN_VERSION`: the deprecated 0.x
   * releases share the package name, and npm must never install one.
   */
  private async refuseTooOld(version: string): Promise<boolean> {
    if (agentVersionAtLeast(version, AGENT_MIN_VERSION)) return false;
    const error = `Version ${version} is older than ${AGENT_PACKAGE} ${AGENT_MIN_VERSION}`;
    // The desired version comes with every heartbeat: say it once.
    if (this.state.lastError !== error) {
      this.options.logger.warn({ version }, "refusing to update to a version below the minimum");
      this.state.lastError = error;
      await this.save();
    }
    return true;
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

  /**
   * Drains, then installs what `retarget` says then (the pin or the
   * organization's version may have changed meanwhile; null: nothing to do).
   */
  private async update(
    version: string,
    daemon: DrainableDaemon,
    retarget: () => string | null,
  ): Promise<void> {
    const log = this.options.logger;
    this.phase = "draining";
    this.target = version;
    this.changed();
    log.info(
      { from: this.options.runningVersion, to: version },
      "updating: taking no new jobs and waiting for the running ones",
    );
    await daemon.drain(this.drainTimeoutMs);
    if (daemon.isStopping()) {
      this.phase = "idle";
      this.target = null;
      this.changed();
      return;
    }
    const next = retarget();
    if (!next || next === this.options.runningVersion || (await this.refuseTooOld(next))) {
      log.info(
        { version, now: next },
        "the target changed during the drain; staying on this version",
      );
      this.phase = "idle";
      this.target = null;
      this.changed();
      daemon.resume();
      return;
    }
    if (next !== version) {
      log.info({ from: version, to: next }, "the target changed during the drain");
      version = next;
      this.target = next;
    }
    this.phase = "installing";
    this.changed();
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

  private async save(): Promise<void> {
    try {
      await writeUpdateState(this.options.statePath, this.state);
    } finally {
      this.changed();
    }
  }

  private changed(): void {
    try {
      this.emit("change");
    } catch (error) {
      this.options.logger.warn({ err: error }, "an update listener failed");
    }
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
