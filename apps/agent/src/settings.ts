import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { watch as fsWatch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentLocalSettings,
  EMPTY_LOCAL_SETTINGS,
  applyLocalSettingsSection,
  effectiveLocalSettings,
  type EffectiveLocalSettings,
  type LocalSettingsRevision,
  type LocalSettingsSection,
  type LocalSettingsSectionBodies,
} from "@omniralph/shared";
import { ConfigError, privateJsonText, writePrivateJson } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * The agent's machine settings (`<dataDir>/settings.json`, `AgentLocalSettings`):
 * the only source of its slots, kinds, host tool paths, installables
 * allow-list and version pin. The agent page saves one section at a time
 * against the revision it read; a hand edit applies like a save once the file
 * has been quiet for `SETTINGS_DEBOUNCE_MS`, and an invalid one is ignored.
 */

export const SETTINGS_FILE = "settings.json";

/** How long the file must be quiet before a hand edit is read. */
export const SETTINGS_DEBOUNCE_MS = 250;

export function localSettingsPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_FILE);
}

/** The filesystem calls the store makes. */
export interface SettingsFs {
  /** Throws an `ENOENT` error for a missing file. */
  readFile: (file: string) => Promise<Buffer>;
  /** Writes atomically, mode 0600 (`writePrivateJson`). */
  writePrivateJson: (file: string, value: unknown) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
  /** Calls `listener` with the entry name whenever something in `dir` changes (null: unknown). */
  watch: (
    dir: string,
    listener: (filename: string | null) => void,
    onError: (error: Error) => void,
  ) => { close: () => void };
}

export const nodeSettingsFs: SettingsFs = {
  readFile: (file) => readFile(file),
  writePrivateJson,
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  watch: (dir, listener, onError) => {
    // The directory, not the file: an atomic write replaces the file's inode.
    const watcher = fsWatch(dir, { persistent: false }, (_event, filename) =>
      listener(filename === null ? null : String(filename)),
    );
    watcher.on("error", onError);
    return watcher;
  },
};

/** Timers for the hand-edit debounce. */
export interface SettingsClock {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const nodeClock: SettingsClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface LocalSettingsState {
  /** As in the file (`{ v: 1 }` when there is none). */
  settings: AgentLocalSettings;
  effective: EffectiveLocalSettings;
  /** SHA-256 of the file's bytes, or `"none"` when there is no file. */
  revision: LocalSettingsRevision;
  /**
   * Why the file on disk isn't in force (an invalid hand edit), until a valid
   * version is read or saved; null when it is.
   */
  lastError: string | null;
}

export type LocalSettingsUpdate =
  | { status: "saved"; state: LocalSettingsState }
  /** `revision` isn't the current one: nothing was written. */
  | { status: "conflict"; state: LocalSettingsState }
  /** The section would make the settings invalid: nothing was written. */
  | { status: "invalid"; issues: SettingsIssue[] };

/** Why a value isn't valid, at its path in the settings (e.g. `["poolLimits", "long"]`). */
export interface SettingsIssue {
  path: (string | number)[];
  message: string;
}

export interface LocalSettingsStoreOptions {
  /** `localSettingsPath(dataDir)`. */
  file: string;
  logger: Logger;
  fs?: SettingsFs;
  clock?: SettingsClock;
}

interface Loaded {
  settings: AgentLocalSettings;
  revision: LocalSettingsRevision;
}

type LoadResult = { ok: true; loaded: Loaded } | { ok: false; error: string };

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type ZodIssueLike = { path: PropertyKey[]; message: string };

export function settingsIssues(issues: readonly ZodIssueLike[]): SettingsIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === "number" ? key : String(key))),
    message: issue.message,
  }));
}

function describeIssues(issues: readonly ZodIssueLike[]): string[] {
  return issues.map((issue) =>
    issue.path.length ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message,
  );
}

/**
 * Reads and writes `settings.json`. Emits `change` (with the new state) after
 * its own writes and after a hand edit it applied or refused, and serializes
 * reads of the file with writes, so a save never races a hand edit.
 */
export class LocalSettingsStore extends EventEmitter<{ change: [LocalSettingsState] }> {
  private readonly fs: SettingsFs;
  private readonly clock: SettingsClock;
  private loaded: Loaded = { settings: EMPTY_LOCAL_SETTINGS, revision: "none" };
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private debounce: unknown = null;
  private watcher: { close: () => void } | null = null;
  private closed = false;

  private constructor(private readonly options: LocalSettingsStoreOptions) {
    super();
    this.fs = options.fs ?? nodeSettingsFs;
    this.clock = options.clock ?? nodeClock;
  }

  /**
   * Reads the file. Throws a `ConfigError` when it isn't valid: with no last
   * good settings, the agent doesn't start.
   */
  static async open(options: LocalSettingsStoreOptions): Promise<LocalSettingsStore> {
    const store = new LocalSettingsStore(options);
    const result = await store.load();
    if (!result.ok) throw new ConfigError(`${options.file} isn't valid: ${result.error}`);
    store.loaded = result.loaded;
    return store;
  }

  get file(): string {
    return this.options.file;
  }

  read(): LocalSettingsState {
    const settings = structuredClone(this.loaded.settings);
    return {
      settings,
      effective: effectiveLocalSettings(settings),
      revision: this.loaded.revision,
      lastError: this.lastError,
    };
  }

  /** The settings in force, with every default filled in. */
  effective(): EffectiveLocalSettings {
    return effectiveLocalSettings(this.loaded.settings);
  }

  /** Starts applying hand edits of the file (creating its directory when missing). */
  async watch(): Promise<void> {
    if (this.watcher || this.closed) return;
    const dir = path.dirname(this.options.file);
    const name = path.basename(this.options.file);
    await this.fs.mkdir(dir);
    this.watcher = this.fs.watch(
      dir,
      (filename) => {
        if (filename === null || filename === name) this.scheduleReload();
      },
      (error) => this.options.logger.warn({ err: error }, "watching settings.json failed"),
    );
  }

  /**
   * Replaces one section, when `revision` is still the current one: writes
   * the file atomically (0600) and returns the new state. A hand edit not yet
   * applied is read first, so saving over it answers a conflict.
   */
  update<S extends LocalSettingsSection>(
    section: S,
    body: Omit<LocalSettingsSectionBodies[S], "revision">,
    revision: string,
  ): Promise<LocalSettingsUpdate> {
    return this.enqueue(async () => {
      this.cancelReload();
      await this.reload();
      if (revision !== this.loaded.revision) return { status: "conflict", state: this.read() };
      const parsed = AgentLocalSettings.safeParse(
        applyLocalSettingsSection(this.loaded.settings, section, body),
      );
      if (!parsed.success)
        return { status: "invalid", issues: settingsIssues(parsed.error.issues) };
      await this.fs.writePrivateJson(this.options.file, parsed.data);
      this.loaded = { settings: parsed.data, revision: sha256(privateJsonText(parsed.data)) };
      this.lastError = null;
      const state = this.read();
      this.options.logger.info({ section, revision: state.revision }, "saved settings.json");
      this.emit("change", state);
      return { status: "saved", state };
    });
  }

  /** Stops watching; waits for a read or write in progress. */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelReload();
    this.watcher?.close();
    this.watcher = null;
    await this.queue;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private scheduleReload(): void {
    if (this.closed) return;
    this.cancelReload();
    this.debounce = this.clock.setTimeout(() => {
      this.debounce = null;
      void this.enqueue(() => this.reload()).catch((error: unknown) =>
        this.options.logger.error({ err: error }, "reading settings.json failed"),
      );
    }, SETTINGS_DEBOUNCE_MS);
  }

  private cancelReload(): void {
    if (this.debounce === null) return;
    this.clock.clearTimeout(this.debounce);
    this.debounce = null;
  }

  /** Applies the file on disk when it changed and is valid; else records why not. */
  private async reload(): Promise<void> {
    const result = await this.load();
    if (!result.ok) {
      if (result.error === this.lastError) return;
      this.lastError = result.error;
      this.options.logger.error(
        { file: this.options.file, issue: result.error },
        `settings.json isn't valid: ${result.error}; the agent keeps its last good settings`,
      );
      this.emit("change", this.read());
      return;
    }
    if (result.loaded.revision === this.loaded.revision && this.lastError === null) return;
    this.loaded = result.loaded;
    this.lastError = null;
    const state = this.read();
    this.options.logger.info({ revision: state.revision }, "applied an edit of settings.json");
    this.emit("change", state);
  }

  private async load(): Promise<LoadResult> {
    let bytes: Buffer;
    try {
      bytes = await this.fs.readFile(this.options.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, loaded: { settings: EMPTY_LOCAL_SETTINGS, revision: "none" } };
      }
      return { ok: false, error: `it can't be read (${(error as Error).message})` };
    }
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { ok: false, error: "it isn't valid JSON" };
    }
    const parsed = AgentLocalSettings.safeParse(json);
    if (!parsed.success) {
      return { ok: false, error: describeIssues(parsed.error.issues).join("; ") };
    }
    return { ok: true, loaded: { settings: parsed.data, revision: sha256(bytes) } };
  }
}
