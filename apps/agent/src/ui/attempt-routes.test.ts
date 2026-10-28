import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LABELED_JOB_TYPES,
  RALPH_STORY_JOB_TYPE,
  REPO_SYNC_JOB_TYPE,
  type RunSpec,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptHistory, type AttemptRecord } from "../attempts/history.js";
import { createLogger, silentLogger, type AgentLog } from "../logger.js";
import { logDirectory } from "../logs/rotating-file.js";
import { LogRing } from "../logs/ring.js";
import { sessionRequest } from "../test/fake-query.js";
import {
  ATTEMPT_NOT_FOUND,
  RECENT_ATTEMPTS,
  attemptLogLines,
  attemptRoutes,
  type AttemptLogSources,
  type AttemptPageState,
  type AttemptsState,
} from "./attempt-routes.js";
import { UiEventHub } from "./events.js";
import { publishLocalChanges } from "./publish.js";
import { startUiServer, uiCookieName, type UiServer } from "./server.js";

const TOKEN = "t".repeat(43);
const REPO = { provider: "github" as const, fullPath: "acme/web/customer-portal" };
const RUN_ID = "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f40";

function get(server: UiServer, pathname: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: pathname,
        headers: {
          host: `127.0.0.1:${server.port}`,
          cookie: `${uiCookieName(server.port)}=${TOKEN}`,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function storyJob() {
  return {
    job: { id: randomUUID(), type: RALPH_STORY_JOB_TYPE, taskType: "coding" as const, payload: {} },
    spec: {
      trigger: {
        kind: "linear.delegated",
        context: {
          runId: RUN_ID,
          repository: REPO,
          epic: { identifier: "SOC-1719" },
          story: { identifier: "SOC-1720" },
        },
      },
      repository: REPO,
    } as unknown as RunSpec,
  };
}

describe("the attempt routes", () => {
  let dir: string;
  let clock: Date;
  let history: AttemptHistory;
  let hub: UiEventHub;
  let published: { resource: string; ids?: string[]; data?: unknown }[];
  let servers: UiServer[];
  let unpublish: (() => void)[];
  let logs: AgentLog[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-attempt-routes-"));
    clock = new Date("2026-10-28T10:00:00.000Z");
    history = new AttemptHistory({ logger: silentLogger(), now: () => clock });
    hub = new UiEventHub();
    published = [];
    vi.spyOn(hub, "publish").mockImplementation((resource, change) => {
      published.push({
        resource,
        ...(change?.ids && { ids: change.ids }),
        ...(change?.data !== undefined && { data: change.data }),
      });
    });
    servers = [];
    unpublish = [];
    logs = [];
  });

  afterEach(async () => {
    for (const stop of unpublish) stop();
    for (const server of servers) await server.close();
    for (const log of logs) log.close();
    await history.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(log: AttemptLogSources = {}) {
    // The same wiring as `runAgent` (the other sources don't matter here).
    unpublish.push(
      publishLocalChanges(hub, {
        settings: new EventEmitter() as never,
        history,
        claude: new EventEmitter() as never,
        storage: new EventEmitter() as never,
      }),
    );
    const server = await startUiServer({
      port: 0,
      agentId: "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10",
      version: "2.0.3",
      bundleDir: "/nonexistent",
      state: async () => ({}),
      hub,
      routes: attemptRoutes({ history, log, logger: silentLogger() }),
      token: TOKEN,
      logger: silentLogger(),
    });
    servers.push(server);
    return server;
  }

  it("lists the running attempts and the last 50 finished ones, with their labels", async () => {
    const server = await start();
    const done: string[] = [];
    for (let i = 0; i < RECENT_ATTEMPTS + 3; i++) {
      const id = randomUUID();
      history.start({
        id,
        type: REPO_SYNC_JOB_TYPE,
        taskType: "system",
        payload: { repository: REPO },
      });
      history.finish(id, i % 2 ? "failed" : "completed", i % 2 ? "fetch failed" : null);
      done.unshift(id);
    }
    const story = storyJob();
    history.start(story.job, story.spec);

    const reply = await get(server, "/api/attempts");
    expect(reply.status).toBe(200);
    const body = reply.body as AttemptsState;
    expect(body.running).toEqual([
      expect.objectContaining({
        id: story.job.id,
        label: "Building SOC-1720",
        runId: RUN_ID,
        repo: REPO,
        workItem: "SOC-1719",
        story: "SOC-1720",
        outcome: null,
      }),
    ]);
    expect(body.recent).toHaveLength(RECENT_ATTEMPTS);
    expect(body.recent.map((a) => a.id)).toEqual(done.slice(0, RECENT_ATTEMPTS));
    expect(body.recent[0]).toMatchObject({ outcome: "completed", label: "Synced customer-portal" });
    expect(body.recent[1]).toMatchObject({
      outcome: "failed",
      error: "fetch failed",
      label: "Couldn't sync customer-portal",
    });
  });

  it("labels every known job type without showing the type", async () => {
    const server = await start();
    for (const type of LABELED_JOB_TYPES) {
      const id = randomUUID();
      history.start({ id, type, taskType: "system", payload: {} });
      history.finish(id, "completed");
    }
    const { recent } = (await get(server, "/api/attempts")).body as AttemptsState;
    expect(recent.length).toBeGreaterThan(0);
    for (const attempt of recent) {
      expect(attempt.label).not.toBe("");
      for (const type of LABELED_JOB_TYPES) expect(attempt.label).not.toContain(type);
    }
  });

  it("answers one attempt with its transcript so far and its log lines", async () => {
    const ring = new LogRing();
    const server = await start({ ring });
    const story = storyJob();
    const sessions = history.start(story.job, story.spec);
    const other = randomUUID();
    ring.write(JSON.stringify({ level: 30, time: 1, msg: "claimed", jobId: story.job.id }));
    ring.write(JSON.stringify({ level: 30, time: 2, msg: "someone else's", jobId: other }));
    ring.write(JSON.stringify({ level: 40, time: 3, msg: "retrying", jobId: story.job.id }));
    await sessions.runner(async (req) => {
      req.onEvent?.({ type: "text", text: "Reading the PRD." });
      return { stop: "completed", output: "", usage: { inputTokens: 0, outputTokens: 0 } };
    })(sessionRequest());

    const reply = await get(server, `/api/attempts/${story.job.id}`);
    expect(reply.status).toBe(200);
    const body = reply.body as AttemptPageState;
    expect(body).toMatchObject({ id: story.job.id, label: "Building SOC-1720", runId: RUN_ID });
    expect(body.events).toEqual([
      { type: "thought", body: "Reading the PRD.", parameter: null, at: clock.toISOString() },
    ]);
    expect(body.log.map((entry) => entry.msg)).toEqual(["claimed", "retrying"]);
  });

  it("answers 404 for an attempt this agent doesn't know", async () => {
    const server = await start();
    const reply = await get(server, `/api/attempts/${randomUUID()}`);
    expect(reply).toEqual({ status: 404, body: { error: ATTEMPT_NOT_FOUND } });
  });

  it("publishes attempts on start and finish, and transcript events with the new events", async () => {
    await start();
    const story = storyJob();
    const sessions = history.start(story.job, story.spec);
    await sessions.runner(async (req) => {
      req.onEvent?.({ type: "text", text: "Reading the PRD." });
      return { stop: "completed", output: "", usage: { inputTokens: 0, outputTokens: 0 } };
    })(sessionRequest());
    history.finish(story.job.id, "failed", "tests failed");

    expect(published).toEqual([
      { resource: "attempts", ids: [story.job.id] },
      {
        resource: "transcript",
        ids: [story.job.id],
        data: [
          { type: "thought", body: "Reading the PRD.", parameter: null, at: clock.toISOString() },
        ],
      },
      { resource: "attempts", ids: [story.job.id] },
    ]);
  });
});

describe("attemptLogLines", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-attempt-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the attempt's lines from the log files, oldest first", async () => {
    const lines: string[] = [];
    const log = createLogger({
      dataDir: dir,
      stderr: { write: (line: string) => lines.push(line) } as never,
    });
    const attempt: Pick<AttemptRecord, "id" | "startedAt"> = {
      id: randomUUID(),
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const job = log.logger.child({ jobId: attempt.id });
    job.info("claimed");
    log.logger.info({ jobId: randomUUID() }, "someone else's");
    // Mentions the ID without being the attempt's line.
    log.logger.info({ note: attempt.id }, "about it");
    job.warn("retrying");
    log.close();

    const entries = await attemptLogLines({ dir: logDirectory(dir) }, attempt);
    expect(entries.map((entry) => entry.msg)).toEqual(["claimed", "retrying"]);
    expect(entries[1]).toMatchObject({ level: "warn", fields: { jobId: attempt.id } });
    expect(lines.length).toBe(4);
  });

  it("keeps the newest lines when there are more than the limit", () => {
    const ring = new LogRing();
    for (let i = 0; i < 5; i++) {
      ring.write(JSON.stringify({ level: 30, time: i, msg: `line ${i}`, jobId: "job-1" }));
    }
    return attemptLogLines({ ring }, { id: "job-1", startedAt: new Date(0).toISOString() }, 2).then(
      (entries) => expect(entries.map((entry) => entry.msg)).toEqual(["line 3", "line 4"]),
    );
  });
});
