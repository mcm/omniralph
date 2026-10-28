import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLogPage } from "./read.js";
import { RotatingFile } from "./rotating-file.js";

let dir: string;

beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(tmpdir(), "agent-logs-")), "logs");
});

afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

function line(i: number, level: 30 | 40 | 50 = 30, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ level, time: 1_000 + i, pid: 1, hostname: "h", name: "omniralph-agent", ...extra, msg: `line ${i}` })}\n`;
}

/** Writes lines 0..n-1 through a rotating file with 3 lines per file. */
function writeLines(n: number, lineFor: (i: number) => string = (i) => line(i)): RotatingFile {
  const file = new RotatingFile({ dir, maxBytes: 3 * line(0).length + 5 });
  for (let i = 0; i < n; i++) file.write(lineFor(i));
  return file;
}

const msgs = (page: { entries: { msg: string }[] }) => page.entries.map((entry) => entry.msg);

describe("readLogPage", () => {
  it("reads newest first and parses each line", async () => {
    writeLines(2, (i) => line(i, 40, { jobId: "job-1" })).close();
    const page = await readLogPage({ dir, limit: 10 });
    expect(page).toEqual({
      entries: [
        { time: 1_001, level: "warn", msg: "line 1", fields: { jobId: "job-1" } },
        { time: 1_000, level: "warn", msg: "line 0", fields: { jobId: "job-1" } },
      ],
      before: null,
    });
  });

  it("pages back across a rotation boundary", async () => {
    // agent.log.2: 0-2, agent.log.1: 3-5, agent.log: 6-7
    writeLines(8).close();
    const first = await readLogPage({ dir, limit: 4 });
    expect(msgs(first)).toEqual(["line 7", "line 6", "line 5", "line 4"]);
    const second = await readLogPage({ dir, limit: 4, before: first.before! });
    expect(msgs(second)).toEqual(["line 3", "line 2", "line 1", "line 0"]);
    const third = await readLogPage({ dir, limit: 4, before: second.before! });
    expect(third).toEqual({ entries: [], before: null });
  });

  it("keeps its place when the file rotates between pages", async () => {
    const file = writeLines(5); // agent.log.1: 0-2, agent.log: 3-4
    const first = await readLogPage({ dir, limit: 3 });
    expect(msgs(first)).toEqual(["line 4", "line 3", "line 2"]);
    // agent.log becomes agent.log.1 (3-5), the cursor's file is now agent.log.2.
    file.write(line(5));
    file.write(line(6));
    file.close();
    const second = await readLogPage({ dir, limit: 3, before: first.before! });
    expect(msgs(second)).toEqual(["line 1", "line 0"]);
    expect(second.before).toBeNull();
  });

  it("filters by the lowest level", async () => {
    writeLines(9, (i) => line(i, ([30, 40, 50] as const)[i % 3])).close();
    const page = await readLogPage({ dir, limit: 4, level: "warn" });
    expect(msgs(page)).toEqual(["line 8", "line 7", "line 5", "line 4"]);
    expect(page.entries.map((entry) => entry.level)).toEqual(["error", "warn", "error", "warn"]);
    const rest = await readLogPage({ dir, limit: 4, level: "warn", before: page.before! });
    expect(msgs(rest)).toEqual(["line 2", "line 1"]);
  });

  it("filters by text in the message or the fields, ignoring case", async () => {
    writeLines(6, (i) => line(i, 30, i === 1 ? { repo: "Customer-Portal" } : {})).close();
    expect(msgs(await readLogPage({ dir, limit: 10, q: "customer-portal" }))).toEqual(["line 1"]);
    expect(msgs(await readLogPage({ dir, limit: 10, q: "LINE 4" }))).toEqual(["line 4"]);
  });

  it("skips lines that aren't pino JSON", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "agent.log"), `${line(0)}not json\n{"half":\n${line(1)}`);
    expect(msgs(await readLogPage({ dir, limit: 10 }))).toEqual(["line 1", "line 0"]);
  });

  it("reads lines longer than its read chunk", async () => {
    await mkdir(dir, { recursive: true });
    const big = "é".repeat(100_000);
    await writeFile(path.join(dir, "agent.log"), line(0) + line(1, 30, { big }) + line(2));
    const page = await readLogPage({ dir, limit: 10 });
    expect(msgs(page)).toEqual(["line 2", "line 1", "line 0"]);
    expect(page.entries[1]!.fields.big).toBe(big);
  });

  it("is empty without a log, and for a cursor whose file is gone", async () => {
    expect(await readLogPage({ dir, limit: 10 })).toEqual({ entries: [], before: null });
    writeLines(2).close();
    expect(await readLogPage({ dir, limit: 10, before: "1:10" })).toEqual({
      entries: [],
      before: null,
    });
    expect(await readLogPage({ dir, limit: 10, before: "nonsense" })).toEqual({
      entries: [],
      before: null,
    });
  });
});
