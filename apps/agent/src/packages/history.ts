/**
 * The agent's install history: every install, update and removal of an
 * installable, from the agent page (`local`) or Fleet's `install` RPC
 * (`fleet`), with npm's output, kept in `<dataDir>/state/installs.json`.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writePrivateJson } from "../config.js";
import type { Logger } from "../logger.js";

/** Installs kept in `installs.json`. */
export const INSTALL_HISTORY_SIZE = 50;
/** Most bytes of npm output kept per install (its tail). */
export const INSTALL_OUTPUT_MAX_BYTES = 64 * 1024;
/** Longest error kept per install. */
const MAX_ERROR = 4_000;

/** `<dataDir>/state/installs.json`. */
export function installsPath(dataDir: string): string {
  return path.join(dataDir, "state", "installs.json");
}

export const INSTALL_ACTIONS = ["install", "remove"] as const;
export type InstallAction = (typeof INSTALL_ACTIONS)[number];
/** Who asked: the agent page (`local`) or Fleet (the `install` RPC). */
export const INSTALL_SOURCES = ["local", "fleet"] as const;
export type InstallSource = (typeof INSTALL_SOURCES)[number];
export const INSTALL_OUTCOMES = ["installed", "removed", "failed"] as const;
export type InstallOutcome = (typeof INSTALL_OUTCOMES)[number];

export const InstallRecord = z.object({
  id: z.string().min(1),
  action: z.enum(INSTALL_ACTIONS),
  /** The package name. */
  name: z.string().min(1),
  /** The version or dist-tag asked for; null for a removal. */
  version: z.string().nullable(),
  /** The version installed afterwards; null until it finished, and after a removal or failure. */
  installedVersion: z.string().nullable(),
  /** The version installed before, if any. */
  previousVersion: z.string().nullable(),
  from: z.enum(INSTALL_SOURCES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Null while it is queued or running. */
  outcome: z.enum(INSTALL_OUTCOMES).nullable(),
  error: z.string().nullable(),
  /** npm's output, its last `INSTALL_OUTPUT_MAX_BYTES`. */
  output: z.string(),
});
export type InstallRecord = z.infer<typeof InstallRecord>;
/** A history row, without its output. */
export type InstallSummary = Omit<InstallRecord, "output">;

const InstallsFile = z.object({
  v: z.literal(1),
  /** Newest first. */
  installs: z.array(InstallRecord),
});

/** The error of an install the agent stopped in the middle of. */
export const INSTALL_INTERRUPTED = "The agent stopped before this finished.";

/** The last `maxBytes` of `text` (UTF-8), cut at a line when one is near. */
export function capOutput(text: string, maxBytes = INSTALL_OUTPUT_MAX_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // Skip continuation bytes so the cut never splits a character.
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  const tail = bytes.subarray(start).toString("utf8");
  const newline = tail.indexOf("\n");
  return newline >= 0 && newline < 200 ? tail.slice(newline + 1) : tail;
}

export function installSummary(record: InstallRecord): InstallSummary {
  const { output: _output, ...summary } = record;
  return summary;
}

export interface InstallHistoryOptions {
  /** `installs.json`; unset: nothing is persisted (tests). */
  file?: string;
  logger: Logger;
  /** Installs kept (default `INSTALL_HISTORY_SIZE`). */
  size?: number;
  now?: () => Date;
  newId?: () => string;
}

/**
 * The last `size` installs, newest first, persisted to `installs.json` (0600,
 * written atomically) on every change. Emits `change` with the summary of
 * the install that started or finished.
 */
export class InstallHistory extends EventEmitter<{ change: [InstallSummary] }> {
  private records: InstallRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  private readonly size: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: InstallHistoryOptions) {
    super();
    this.size = options.size ?? INSTALL_HISTORY_SIZE;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /**
   * Loads `installs.json`; a missing file is an empty history, an invalid one
   * is logged and ignored. Installs that never finished (the agent stopped)
   * are marked failed.
   */
  async load(): Promise<void> {
    const { file, logger } = this.options;
    if (!file) return;
    let json: unknown;
    try {
      json = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err: error, file }, "couldn't read the install history; starting a new one");
      }
      return;
    }
    const parsed = InstallsFile.safeParse(json);
    if (!parsed.success) {
      logger.warn(
        { file, issues: parsed.error.issues.slice(0, 5) },
        "the install history isn't valid; starting a new one",
      );
      return;
    }
    let interrupted = false;
    this.records = parsed.data.installs.slice(0, this.size).map((record) => {
      if (record.outcome !== null) return record;
      interrupted = true;
      return {
        ...record,
        finishedAt: record.finishedAt ?? this.now().toISOString(),
        outcome: "failed",
        error: INSTALL_INTERRUPTED,
      };
    });
    if (interrupted) this.persist();
  }

  /** Records an install or removal that was just asked for (queued). */
  start(entry: {
    action: InstallAction;
    name: string;
    version: string | null;
    previousVersion: string | null;
    from: InstallSource;
  }): InstallSummary {
    const record: InstallRecord = {
      id: this.newId(),
      ...entry,
      installedVersion: null,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      outcome: null,
      error: null,
      output: "",
    };
    this.records = [record, ...this.records].slice(0, this.size);
    return this.changed(record);
  }

  /** Records how it ended. */
  finish(
    id: string,
    result: {
      outcome: InstallOutcome;
      installedVersion?: string | null;
      previousVersion?: string | null;
      error?: string | null;
      output?: string;
    },
  ): InstallSummary | undefined {
    const index = this.records.findIndex((r) => r.id === id);
    if (index < 0) return undefined;
    const before = this.records[index]!;
    const record: InstallRecord = {
      ...before,
      outcome: result.outcome,
      installedVersion: result.installedVersion ?? null,
      previousVersion:
        result.previousVersion === undefined ? before.previousVersion : result.previousVersion,
      error: result.error ? result.error.slice(0, MAX_ERROR) : null,
      output: capOutput(result.output ?? ""),
      finishedAt: this.now().toISOString(),
    };
    this.records[index] = record;
    return this.changed(record);
  }

  /** Newest first, without output. */
  list(): InstallSummary[] {
    return this.records.map(installSummary);
  }

  /** One install with its output. */
  get(id: string): InstallRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** Resolves once every write so far is on disk (or failed and was logged). */
  flush(): Promise<void> {
    return this.writes;
  }

  private changed(record: InstallRecord): InstallSummary {
    this.persist();
    const summary = installSummary(record);
    this.emit("change", summary);
    return summary;
  }

  /** Writes the history, one write at a time, the latest state each time. */
  private persist(): void {
    const { file } = this.options;
    if (!file) return;
    this.writes = this.writes.then(async () => {
      try {
        await writePrivateJson(file, { v: 1, installs: this.records });
      } catch (error) {
        this.options.logger.warn({ err: error, file }, "couldn't save the install history");
      }
    });
  }
}
