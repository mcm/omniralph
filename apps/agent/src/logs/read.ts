import { open, type FileHandle } from "node:fs/promises";

import { matchesLogFilter, parseLogLine, type LogEntry, type LogFilter } from "./entries.js";
import { DEFAULT_LOG_KEEP, logFilePaths } from "./rotating-file.js";

const CHUNK_BYTES = 64 * 1024;

export interface LogPageOptions extends LogFilter {
  /** The log directory (`logDirectory(dataDir)`). */
  dir: string;
  /** The `before` of the previous page; absent for the newest lines. */
  before?: string;
  /** Lines per page (at least 1). */
  limit: number;
  keep?: number;
  /**
   * Epoch milliseconds: stop at the first line older than this (the log is written in time
   * order), so a search for a recent attempt's lines doesn't read every rotated file.
   */
  since?: number;
}

export interface LogPage {
  /** Newest first. */
  entries: LogEntry[];
  /** Pass back as `before` for the next older page; null when there is none. */
  before: string | null;
}

/**
 * A cursor is `<inode>:<offset>` of the oldest line returned: a rotation renames the file but keeps
 * its inode, so the next page continues where this one stopped even after `agent.log` became
 * `agent.log.1`. A cursor whose file was deleted has nothing older.
 */
function parseCursor(cursor: string): { ino: bigint; offset: number } | undefined {
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (!match) return undefined;
  return { ino: BigInt(match[1]!), offset: Number(match[2]) };
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < buffer.length) {
    const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done);
    if (bytesRead === 0) throw new Error("log file shrank while reading");
    done += bytesRead;
  }
}

/** The lines of `[0, end)`, last first, each with the offset where it starts. */
async function* linesBackward(
  handle: FileHandle,
  end: number,
): AsyncGenerator<{ text: string; offset: number }> {
  let pos = end;
  // Bytes from `pos` on whose line start isn't known yet.
  let tail = Buffer.alloc(0);
  while (pos > 0) {
    const size = Math.min(CHUNK_BYTES, pos);
    pos -= size;
    const chunk = Buffer.alloc(size);
    await readFully(handle, chunk, pos);
    const buffer = Buffer.concat([chunk, tail]);
    let stop = buffer.length;
    let newline = buffer.lastIndexOf(10, stop - 1);
    while (newline !== -1) {
      if (stop > newline + 1) {
        yield {
          text: buffer.subarray(newline + 1, stop).toString("utf8"),
          offset: pos + newline + 1,
        };
      }
      stop = newline;
      newline = stop > 0 ? buffer.lastIndexOf(10, stop - 1) : -1;
    }
    tail = buffer.subarray(0, stop);
  }
  if (tail.length > 0) yield { text: tail.toString("utf8"), offset: 0 };
}

/** Reads the log newest first across `agent.log` and its rotated files, filtered and paged. */
export async function readLogPage(options: LogPageOptions): Promise<LogPage> {
  const limit = Math.max(1, Math.floor(options.limit));
  const cursor = options.before === undefined ? undefined : parseCursor(options.before);
  if (options.before !== undefined && !cursor) return { entries: [], before: null };

  // Open every file first: an open handle keeps reading the same file through a rotation.
  const files: { handle: FileHandle; ino: bigint; size: number }[] = [];
  try {
    for (const file of logFilePaths(options.dir, options.keep ?? DEFAULT_LOG_KEEP)) {
      let handle: FileHandle;
      try {
        handle = await open(file, "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const stats = await handle.stat({ bigint: true });
        files.push({ handle, ino: stats.ino, size: Number(stats.size) });
      } catch (error) {
        await handle.close();
        throw error;
      }
    }

    let start = 0;
    if (cursor) {
      start = files.findIndex((file) => file.ino === cursor.ino);
      if (start === -1) return { entries: [], before: null };
    }
    const entries: LogEntry[] = [];
    for (let i = start; i < files.length; i++) {
      const file = files[i]!;
      const end = i === start && cursor ? Math.min(cursor.offset, file.size) : file.size;
      for await (const line of linesBackward(file.handle, end)) {
        const entry = parseLogLine(line.text);
        if (entry && options.since !== undefined && entry.time < options.since) {
          return { entries, before: null };
        }
        if (!entry || !matchesLogFilter(entry, line.text, options)) continue;
        entries.push(entry);
        if (entries.length === limit) return { entries, before: `${file.ino}:${line.offset}` };
      }
    }
    return { entries, before: null };
  } finally {
    await Promise.all(files.map((file) => file.handle.close()));
  }
}
