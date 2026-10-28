import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { logFilePaths, RotatingFile } from "./rotating-file.js";

let dir: string;

beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(tmpdir(), "agent-logs-")), "logs");
});

afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

const line = (i: number) => `{"n":${String(i).padStart(4, "0")}}\n`; // 13 bytes

async function allLines(): Promise<string[]> {
  const out: string[] = [];
  // Oldest file first.
  for (const file of logFilePaths(dir).reverse()) {
    const text = await readFile(file, "utf8").catch(() => "");
    out.push(...text.split("\n").filter(Boolean));
  }
  return out;
}

describe("RotatingFile", () => {
  it("creates the directory 0700 and the file 0600", async () => {
    const file = new RotatingFile({ dir });
    file.write(line(1));
    file.close();
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, "agent.log"))).mode & 0o777).toBe(0o600);
  });

  it("rotates before a line would pass the limit and never loses or splits one", async () => {
    const file = new RotatingFile({ dir, maxBytes: 40, keep: 5 });
    // 3 lines (39 bytes) per file; 18 lines fill the current file and all 5 rotated ones.
    for (let i = 0; i < 18; i++) file.write(line(i));
    file.close();
    expect(await allLines()).toEqual(Array.from({ length: 18 }, (_, i) => line(i).trim()));
    for (const name of logFilePaths(dir)) {
      expect((await stat(name)).size).toBeLessThanOrEqual(40);
      expect((await stat(name)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps agent.log.1 to .5 and deletes older files", async () => {
    const file = new RotatingFile({ dir, maxBytes: 40, keep: 5 });
    await writeFile(path.join(dir, "agent.log.6"), "old\n");
    await writeFile(path.join(dir, "agent.log.9"), "old\n");
    for (let i = 0; i < 30; i++) file.write(line(i));
    file.close();
    expect((await readdir(dir)).sort()).toEqual([
      "agent.log",
      "agent.log.1",
      "agent.log.2",
      "agent.log.3",
      "agent.log.4",
      "agent.log.5",
    ]);
    // The newest 18 lines are kept, in order.
    expect(await allLines()).toEqual(Array.from({ length: 18 }, (_, i) => line(i + 12).trim()));
  });

  it("appends to an existing file and counts its size", async () => {
    new RotatingFile({ dir }).close();
    await writeFile(path.join(dir, "agent.log"), line(0) + line(1) + line(2));
    const file = new RotatingFile({ dir, maxBytes: 40 });
    file.write(line(3));
    file.close();
    expect(await readFile(path.join(dir, "agent.log.1"), "utf8")).toBe(line(0) + line(1) + line(2));
    expect(await readFile(path.join(dir, "agent.log"), "utf8")).toBe(line(3));
  });

  it("writes a line longer than the limit whole, into a file of its own", async () => {
    const file = new RotatingFile({ dir, maxBytes: 20 });
    file.write(line(0));
    file.write(`{"long":"${"x".repeat(50)}"}\n`);
    file.write(line(1));
    file.close();
    expect(await allLines()).toEqual([
      line(0).trim(),
      `{"long":"${"x".repeat(50)}"}`,
      line(1).trim(),
    ]);
  });

  it("reports a failing write once and keeps going", async () => {
    const errors: unknown[] = [];
    const file = new RotatingFile({ dir, maxBytes: 20, onError: (error) => errors.push(error) });
    file.write(line(0));
    // The directory is gone: the rotation and reopening fail.
    await rm(dir, { recursive: true });
    file.write(line(1));
    file.write(line(2));
    expect(errors).toHaveLength(1);
    file.close();
    file.write(line(3));
    expect(errors).toHaveLength(1);
  });

  it("drops lines after close", async () => {
    const file = new RotatingFile({ dir });
    file.write(line(0));
    file.close();
    file.write(line(1));
    expect(await readFile(path.join(dir, "agent.log"), "utf8")).toBe(line(0));
  });
});
