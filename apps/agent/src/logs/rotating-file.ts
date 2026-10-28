import {
  chmodSync,
  closeSync,
  fstatSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

/** Rotate `agent.log` once it would grow past 10 MB. */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Rotated files kept: `agent.log.1` (newest) … `agent.log.5` (oldest). */
export const DEFAULT_LOG_KEEP = 5;
export const LOG_FILE_NAME = "agent.log";

export function logDirectory(dataDir: string): string {
  return path.join(dataDir, "logs");
}

/** The current file first, then the rotated ones, newest to oldest. */
export function logFilePaths(dir: string, keep = DEFAULT_LOG_KEEP): string[] {
  const file = path.join(dir, LOG_FILE_NAME);
  return [file, ...Array.from({ length: keep }, (_, i) => `${file}.${i + 1}`)];
}

export interface RotatingFileOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
  /** Where a write failure is reported, once until a write succeeds again (default stderr). */
  onError?: (error: unknown) => void;
}

/**
 * A pino destination that appends lines to `<dir>/agent.log` and rotates by size.
 *
 * Writes are synchronous, like `pino.destination(2)`: a line is on disk when `write` returns, and a
 * rotation happens between two lines, so none is split or lost. The directory is 0700, files 0600.
 */
export class RotatingFile {
  readonly file: string;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly onError: (error: unknown) => void;
  private fd: number | undefined;
  private size = 0;
  private failing = false;
  private closed = false;

  constructor(options: RotatingFileOptions) {
    this.dir = options.dir;
    this.file = path.join(options.dir, LOG_FILE_NAME);
    this.maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
    this.keep = options.keep ?? DEFAULT_LOG_KEEP;
    this.onError =
      options.onError ??
      ((error) =>
        process.stderr.write(`omniralph-agent: can't write ${this.file}: ${String(error)}\n`));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask, and an existing directory keeps its own.
    chmodSync(this.dir, 0o700);
    this.open();
  }

  write(line: string): void {
    if (this.closed) return;
    try {
      const bytes = Buffer.from(line);
      if (this.fd === undefined) this.open();
      if (this.size > 0 && this.size + bytes.length > this.maxBytes) this.rotate();
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(this.fd!, bytes, offset, bytes.length - offset);
      }
      this.size += bytes.length;
      this.failing = false;
    } catch (error) {
      // A full disk mustn't stop the agent: stderr still has the line.
      if (!this.failing) this.onError(error);
      this.failing = true;
    }
  }

  /** Stops writing; later lines are dropped. */
  close(): void {
    this.closed = true;
    this.closeFd();
  }

  private closeFd(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }

  private open(): void {
    const fd = openSync(this.file, "a", 0o600);
    try {
      fchmodSync(fd, 0o600);
      this.size = fstatSync(fd).size;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.fd = fd;
  }

  private rotate(): void {
    this.closeFd();
    const files = logFilePaths(this.dir, this.keep);
    // Anything past the kept ones (a lower `keep` before, or left by hand) goes.
    const rotated = new RegExp(`^${LOG_FILE_NAME.replace(".", "\\.")}\\.(\\d+)$`);
    for (const name of readdirSync(this.dir)) {
      const match = rotated.exec(name);
      if (match && Number(match[1]) >= this.keep)
        rmSync(path.join(this.dir, name), { force: true });
    }
    for (let i = files.length - 2; i >= 0; i--) {
      try {
        renameSync(files[i]!, files[i + 1]!);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.open();
  }
}
