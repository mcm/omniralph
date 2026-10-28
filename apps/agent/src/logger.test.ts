import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import { readLogPage } from "./logs/read.js";
import { LogRing } from "./logs/ring.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "agent-logger-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function setup(level = "info") {
  const stderr: string[] = [];
  const log = createLogger({ level, dataDir, stderr: { write: (line) => void stderr.push(line) } });
  const file = path.join(dataDir, "logs", "agent.log");
  return { ...log, stderr, file, fileText: () => readFile(file, "utf8") };
}

describe("createLogger", () => {
  it("writes each line to stderr, logs/agent.log and the ring", async () => {
    const { logger, ring, stderr, fileText, file, close } = setup();
    const lines: string[] = [];
    ring.subscribe((entry) => lines.push(entry.msg));
    logger.child({ jobId: "job-1" }).info({ repo: "acme/web" }, "job started");
    close();

    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]!)).toMatchObject({
      name: "omniralph-agent",
      level: 30,
      jobId: "job-1",
      repo: "acme/web",
      msg: "job started",
    });
    expect(await fileText()).toBe(stderr[0]);
    expect(ring.lines()).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "job started",
        fields: { jobId: "job-1", repo: "acme/web" },
      }),
    ]);
    expect(lines).toEqual(["job started"]);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("filters by the logger's level on every target", async () => {
    const { logger, ring, stderr, fileText, close } = setup("warn");
    logger.info("hidden");
    logger.debug("hidden");
    logger.warn("shown");
    close();
    expect(stderr.map((line) => JSON.parse(line).msg)).toEqual(["shown"]);
    expect(ring.lines().map((entry) => entry.msg)).toEqual(["shown"]);
    expect((await fileText()).match(/"msg"/g)).toHaveLength(1);
  });

  it("debug level reaches every target", async () => {
    const { logger, ring, stderr, close } = setup("debug");
    logger.debug("details");
    close();
    expect(stderr).toHaveLength(1);
    expect(ring.lines()).toHaveLength(1);
  });

  it.each([
    ["refreshToken", { refreshToken: "SECRET-refresh" }],
    ["*.token", { session: { token: "SECRET-token" } }],
    ["*.jobToken", { job: { jobToken: "SECRET-job" } }],
    ["*.sessionToken", { claim: { sessionToken: "SECRET-session" } }],
    ["authorization", { authorization: "Bearer SECRET-auth" }],
    [
      "*.headers.authorization",
      { request: { headers: { authorization: "Bearer SECRET-header" } } },
    ],
    ["env", { env: { ANTHROPIC_API_KEY: "SECRET-env" } }],
  ])("censors %s on every target", async (_path, fields) => {
    const { logger, ring, stderr, fileText, close } = setup();
    logger.info(fields, "with a secret");
    logger.child(fields).warn("child with a secret");
    close();
    const targets = [stderr.join(""), await fileText(), JSON.stringify(ring.lines())];
    for (const text of targets) {
      expect(text).toContain("with a secret");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("SECRET");
    }
  });

  it("without a data directory, writes to stderr and the ring only", () => {
    const stderr: string[] = [];
    const { logger, ring, file } = createLogger({
      stderr: { write: (line) => void stderr.push(line) },
    });
    logger.info("hello");
    expect(file).toBeUndefined();
    expect(stderr).toHaveLength(1);
    expect(ring.lines()).toHaveLength(1);
  });

  it("the file is readable newest first", async () => {
    const { logger, close } = setup();
    logger.info("first");
    logger.error({ err: new Error("boom") }, "second");
    close();
    const page = await readLogPage({ dir: path.join(dataDir, "logs"), limit: 10 });
    expect(page.entries.map((entry) => [entry.level, entry.msg])).toEqual([
      ["error", "second"],
      ["info", "first"],
    ]);
  });
});

describe("LogRing", () => {
  it("keeps the last lines and stops calling a listener after it unsubscribes", () => {
    const ring = new LogRing(3);
    const seen: string[] = [];
    const unsubscribe = ring.subscribe((entry) => seen.push(entry.msg));
    for (let i = 0; i < 5; i++) ring.write(`{"level":30,"time":${i},"msg":"m${i}"}\n`);
    unsubscribe();
    ring.write(`{"level":30,"time":5,"msg":"m5"}\n`);
    expect(ring.lines().map((entry) => entry.msg)).toEqual(["m3", "m4", "m5"]);
    expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("holds 2,000 lines by default and survives a throwing listener", () => {
    const ring = new LogRing();
    ring.subscribe(() => {
      throw new Error("broken");
    });
    for (let i = 0; i < 2_005; i++) ring.write(`{"level":30,"time":${i},"msg":"m${i}"}\n`);
    expect(ring.lines()).toHaveLength(2_000);
    expect(ring.lines()[0]!.msg).toBe("m5");
  });
});
