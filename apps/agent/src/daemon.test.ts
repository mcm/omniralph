import { randomUUID } from "node:crypto";
import type {
  HeartbeatResponse,
  JobFailure,
  JobOutcomeResponse,
  JobPayload,
  JobStartResponse,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ControlPanelApi } from "./api.js";
import {
  CapabilityRegistry,
  RetryableJobError,
  type Capability,
  type JobContext,
} from "./capabilities/index.js";
import { AgentDaemon, JobCanceled, ShutdownAbort } from "./daemon.js";
import { ralphCapability } from "./capabilities/ralph.js";
import { systemCapability } from "./capabilities/system.js";
import { silentLogger } from "./logger.js";
import type { MessageHandler, QueueReceiver, RetryDirective } from "./queue.js";
import type { ReceiveBatchOptions, ReceiveResult } from "@vercel/queue";
import type { RepoCache } from "./workspace/repoCache.js";

const AGENT_ID = randomUUID();

function centralConfig(overrides: Partial<HeartbeatResponse> = {}): HeartbeatResponse {
  return {
    maxConcurrency: 1,
    pollIntervalSeconds: 5,
    enabledCapabilities: ["review"],
    pinnedRepoIds: [],
    topics: ["review-jobs"],
    queueRegion: "iad1",
    cancelJobIds: [],
    jobTokens: [],
    ...overrides,
  };
}

interface Delivered {
  topic: string;
  message: unknown;
}

/** An in-memory stand-in for `PollingQueueClient.receive` with the SDK's ack/retry semantics. */
class FakeQueue implements QueueReceiver {
  private readonly topics = new Map<string, unknown[]>();
  readonly acked: Delivered[] = [];
  readonly rescheduled: (Delivered & { directive: RetryDirective })[] = [];
  readonly unacked: Delivered[] = [];
  readonly receiveCalls: string[] = [];
  readonly regions: string[] = [];
  inFlight = 0;
  maxInFlight = 0;

  push(topic: string, ...jobIds: string[]): void {
    const queue = this.topics.get(topic) ?? [];
    queue.push(...jobIds.map((jobId) => ({ jobId })));
    this.topics.set(topic, queue);
  }

  async receive<T>(
    topic: string,
    _group: string,
    handler: MessageHandler<T>,
    options?: ReceiveBatchOptions,
  ): Promise<ReceiveResult> {
    this.receiveCalls.push(topic);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const message = this.topics.get(topic)?.shift();
      if (message === undefined) return { ok: false, reason: "empty" };
      const metadata = {
        messageId: randomUUID(),
        deliveryCount: 1,
        createdAt: new Date(),
        expiresAt: new Date(),
        topicName: topic,
        consumerGroup: "agents",
        region: "iad1",
      };
      try {
        await handler(message as T, metadata);
        this.acked.push({ topic, message });
        return { ok: true };
      } catch (error) {
        const directive = options?.retry?.(error, metadata);
        if (directive) {
          this.rescheduled.push({ topic, message, directive });
          return { ok: true };
        }
        this.unacked.push({ topic, message });
        throw error;
      }
    } finally {
      this.inFlight--;
    }
  }
}

function job(id: string, overrides: Partial<JobPayload> = {}): JobPayload {
  return {
    id,
    capability: "review",
    type: "review.run",
    repositoryId: null,
    payload: {},
    deliveryCount: 1,
    ...overrides,
  };
}

function fakeApi(config: HeartbeatResponse = centralConfig()) {
  const state = { config };
  const api = {
    heartbeat: vi.fn(async () => state.config),
    startJob: vi.fn(async (id: string): Promise<JobStartResponse> => ({
      action: "run",
      job: job(id),
      jobToken: { jobId: id, token: `job-token-${id}`, expiresIn: 900 },
    })),
    submitResult: vi.fn(async (): Promise<JobOutcomeResponse> => ({ status: "completed" })),
    submitFailure: vi.fn(async (_id: string, body: JobFailure): Promise<JobOutcomeResponse> =>
      body.retryable
        ? { status: "retry", retryAfterSeconds: body.retryAfterSeconds ?? 60 }
        : { status: "failed" },
    ),
  } satisfies ControlPanelApi;
  return { api, state };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

function capability(run: Capability["run"], overrides: Partial<Capability> = {}): Capability {
  return {
    name: "review",
    jobTypes: ["review.run"],
    toolPolicy: {
      tools: "allowed",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      fileScope: "worktree",
      permissionMode: "dontAsk",
      settingSources: [],
      writable: false,
    },
    run,
    ...overrides,
  };
}

function setup(options: {
  run?: Capability["run"];
  capabilities?: Capability[];
  config?: HeartbeatResponse;
  repos?: RepoCache;
}) {
  const { api, state } = fakeApi(options.config);
  const queue = new FakeQueue();
  const tokens = { refresh: vi.fn(async () => "access") };
  const daemon = new AgentDaemon({
    server: "https://omniralph.example",
    workspaceRoot: "/tmp/omniralph-test",
    repos: options.repos,
    version: "1.2.3",
    api,
    tokens,
    registry: new CapabilityRegistry(
      options.capabilities ?? [capability(options.run ?? (async () => ({ ok: true })))],
    ),
    queue: (region) => {
      queue.regions.push(region);
      return queue;
    },
    logger: silentLogger(),
    reportRetryDelayMs: 10,
  });
  return { api, state, queue, tokens, daemon };
}

/** Lets pending promises and zero-delay timers run. */
async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentDaemon", () => {
  it("heartbeats every 20s with its version, capabilities, running jobs and free slots", async () => {
    const { api, daemon } = setup({});
    void daemon.run();
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.heartbeat).toHaveBeenLastCalledWith({
      version: "1.2.3",
      capabilities: ["review"],
      runningJobIds: [],
      freeSlots: 0,
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(api.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ freeSlots: 1 }));
    await daemon.shutdown();
  });

  it("does not poll before the first successful heartbeat", async () => {
    const { api, queue, daemon } = setup({});
    api.heartbeat.mockRejectedValueOnce(new ApiError(503, undefined, "down"));
    void daemon.run();
    await settle();
    expect(queue.receiveCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(queue.receiveCalls).toEqual(["review-jobs"]);
    await daemon.shutdown();
  });

  it("asks the token manager to refresh when the heartbeat gets 401", async () => {
    const { api, tokens, daemon } = setup({});
    api.heartbeat.mockRejectedValueOnce(new ApiError(401, "unauthorized", "401"));
    void daemon.run();
    await settle();
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    await daemon.shutdown();
  });

  it("runs a job: start, run with the job token, result, then acknowledge", async () => {
    const id = randomUUID();
    const seen: { jobToken?: string; workspaceRoot?: string } = {};
    const { api, queue, daemon } = setup({
      run: async (j, ctx) => {
        seen.jobToken = ctx.jobToken();
        seen.workspaceRoot = ctx.workspaceRoot;
        return { findings: [], jobId: j.id };
      },
    });
    queue.push("review-jobs", id);
    void daemon.run();
    await settle();
    expect(api.startJob).toHaveBeenCalledWith(id);
    expect(seen).toEqual({ jobToken: `job-token-${id}`, workspaceRoot: "/tmp/omniralph-test" });
    expect(api.submitResult).toHaveBeenCalledWith(id, { result: { findings: [], jobId: id } });
    expect(queue.acked).toEqual([{ topic: "review-jobs", message: { jobId: id } }]);
    expect(queue.regions).toEqual(["iad1"]);
    await daemon.shutdown();
  });

  it("acknowledges skipped jobs without running them", async () => {
    const id = randomUUID();
    const run = vi.fn(async () => ({}));
    const { api, queue, daemon } = setup({ run });
    api.startJob.mockResolvedValueOnce({ action: "skip", reason: "canceled" });
    queue.push("review-jobs", id);
    void daemon.run();
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(api.submitResult).not.toHaveBeenCalled();
    expect(api.submitFailure).not.toHaveBeenCalled();
    expect(queue.acked).toHaveLength(1);
    await daemon.shutdown();
  });

  it("acknowledges malformed messages without calling the control panel", async () => {
    const { api, queue, daemon } = setup({});
    queue.push("review-jobs", "not-a-uuid");
    void daemon.run();
    await settle();
    expect(api.startJob).not.toHaveBeenCalled();
    expect(queue.acked).toHaveLength(1);
    await daemon.shutdown();
  });

  it("reschedules a message whose start call failed instead of acknowledging it", async () => {
    const { api, queue, daemon } = setup({});
    api.startJob.mockRejectedValueOnce(new ApiError(502, undefined, "bad gateway"));
    queue.push("review-jobs", randomUUID());
    void daemon.run();
    await settle();
    expect(queue.acked).toEqual([]);
    expect(queue.rescheduled[0]?.directive).toEqual({ afterSeconds: 30 });
    await daemon.shutdown();
  });

  it("reports a retryable failure and leaves the message unacknowledged until retryAfterSeconds", async () => {
    const id = randomUUID();
    const { api, queue, daemon } = setup({
      run: async () => {
        throw new RetryableJobError("rate limited", 120);
      },
    });
    queue.push("review-jobs", id);
    void daemon.run();
    await settle();
    expect(api.submitFailure).toHaveBeenCalledWith(id, {
      retryable: true,
      error: "rate limited",
      retryAfterSeconds: 120,
    });
    expect(queue.acked).toEqual([]);
    expect(queue.rescheduled).toEqual([
      { topic: "review-jobs", message: { jobId: id }, directive: { afterSeconds: 120 } },
    ]);
    await daemon.shutdown();
  });

  it("acknowledges a retryable failure the control panel turns into a final failure", async () => {
    const { api, queue, daemon } = setup({
      run: async () => {
        throw new RetryableJobError("rate limited");
      },
    });
    api.submitFailure.mockResolvedValueOnce({ status: "failed" });
    queue.push("review-jobs", randomUUID());
    void daemon.run();
    await settle();
    expect(api.submitFailure).toHaveBeenCalledWith(expect.any(String), {
      retryable: true,
      error: "rate limited",
    });
    expect(queue.acked).toHaveLength(1);
    expect(queue.rescheduled).toEqual([]);
    await daemon.shutdown();
  });

  it("reports other errors as non-retryable failures and acknowledges", async () => {
    const id = randomUUID();
    const { api, queue, daemon } = setup({
      run: async () => {
        throw new Error("boom");
      },
    });
    queue.push("review-jobs", id);
    void daemon.run();
    await settle();
    expect(api.submitFailure).toHaveBeenCalledWith(id, { retryable: false, error: "boom" });
    expect(queue.acked).toHaveLength(1);
    expect(queue.rescheduled).toEqual([]);
    await daemon.shutdown();
  });

  it("polls ralph topics only once ralph is enabled, and fails its jobs as not implemented", async () => {
    const id = randomUUID();
    const ralphTopic = `ralph-jobs-agent-${AGENT_ID}`;
    const topics = ["review-jobs", "ralph-jobs", ralphTopic];
    const { api, state, queue, daemon } = setup({
      capabilities: [systemCapability, capability(async () => ({})), ralphCapability],
      config: centralConfig({ enabledCapabilities: ["review"], topics }),
    });
    api.startJob.mockResolvedValueOnce({
      action: "run",
      job: job(id, { capability: "ralph", type: "ralph.story" }),
      jobToken: { jobId: id, token: "t", expiresIn: 900 },
    });
    void daemon.run();
    await settle();
    expect(daemon.pollableTopics()).toEqual(["review-jobs"]);
    expect(queue.receiveCalls).not.toContain("ralph-jobs");
    expect(queue.receiveCalls).not.toContain(ralphTopic);

    state.config = centralConfig({ enabledCapabilities: ["review", "ralph"], topics });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(daemon.pollableTopics()).toEqual([ralphTopic, "review-jobs", "ralph-jobs"]);
    queue.push(ralphTopic, id);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(queue.receiveCalls).toContain(ralphTopic);
    expect(api.submitFailure).toHaveBeenCalledWith(id, {
      retryable: false,
      error: "ralph.story jobs are not supported by this agent yet",
    });
    expect(queue.rescheduled).toEqual([]);
    await daemon.shutdown();
  });

  it("reports an unknown job type as a non-retryable failure", async () => {
    const id = randomUUID();
    const run = vi.fn(async () => ({}));
    const { api, queue, daemon } = setup({ run });
    api.startJob.mockResolvedValueOnce({
      action: "run",
      job: job(id, { type: "review.frobnicate" }),
      jobToken: { jobId: id, token: "t", expiresIn: 900 },
    });
    queue.push("review-jobs", id);
    void daemon.run();
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(api.submitFailure).toHaveBeenCalledWith(id, {
      retryable: false,
      error: "unknown job type review/review.frobnicate",
    });
    expect(queue.acked).toHaveLength(1);
    await daemon.shutdown();
  });

  it("drops the outcome when the job was taken over by another agent (409)", async () => {
    const { api, queue, daemon } = setup({});
    api.submitResult.mockRejectedValueOnce(new ApiError(409, "not_current_agent", "409"));
    queue.push("review-jobs", randomUUID());
    void daemon.run();
    await settle();
    expect(api.submitResult).toHaveBeenCalledTimes(1);
    expect(queue.rescheduled).toEqual([]);
    expect(queue.unacked).toEqual([]);
    await daemon.shutdown();
  });

  it("retries reporting, then leaves the message for redelivery", async () => {
    const { api, queue, daemon } = setup({});
    api.submitResult.mockRejectedValue(new ApiError(503, undefined, "down"));
    queue.push("review-jobs", randomUUID());
    void daemon.run();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.submitResult).toHaveBeenCalledTimes(3);
    expect(queue.acked).toEqual([]);
    expect(queue.unacked).toHaveLength(1);
    await daemon.shutdown();
  });

  it("never runs more jobs or receives than maxConcurrency", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    let running = 0;
    let maxRunning = 0;
    const { queue, daemon } = setup({
      config: centralConfig({ maxConcurrency: 2 }),
      run: async (j) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        const gate = deferred();
        gates.set(j.id, gate);
        await gate.promise;
        running--;
        return {};
      },
    });
    const ids = Array.from({ length: 5 }, () => randomUUID());
    queue.push("review-jobs", ...ids);
    void daemon.run();
    await settle();
    expect(running).toBe(2);
    expect(daemon.status().runningJobIds).toEqual(ids.slice(0, 2));

    // Heartbeats while busy report no free slots and don't add pollers.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(queue.maxInFlight).toBe(2);

    gates.get(ids[0]!)!.resolve();
    await settle();
    expect(running).toBe(2);
    expect(daemon.status().runningJobIds).toEqual([ids[1], ids[2]]);
    for (const id of ids.slice(1)) {
      gates.get(id)?.resolve();
      await settle();
    }
    gates.get(ids[4]!)?.resolve();
    await settle();
    expect(queue.acked).toHaveLength(5);
    expect(maxRunning).toBe(2);
    expect(queue.maxInFlight).toBe(2);
    await daemon.shutdown();
  });

  it("applies central config from each heartbeat without restarting", async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    let running = 0;
    let maxRunning = 0;
    const { api, state, queue, daemon } = setup({
      config: centralConfig({ maxConcurrency: 1, topics: ["review-jobs"] }),
      run: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        running--;
        return {};
      },
    });
    const pinnedTopic = `review-jobs-agent-${AGENT_ID}`;
    queue.push(pinnedTopic, randomUUID(), randomUUID(), randomUUID());
    void daemon.run();
    await settle();
    // The pinned topic isn't in the config yet.
    expect(queue.receiveCalls).toEqual(["review-jobs"]);
    expect(running).toBe(0);

    state.config = centralConfig({
      maxConcurrency: 3,
      pollIntervalSeconds: 2,
      topics: ["review-jobs", pinnedTopic, "ralph-jobs"],
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(running).toBe(3);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    // Unregistered capabilities' topics are never polled; pinned topics come first.
    expect(queue.receiveCalls).not.toContain("ralph-jobs");
    const firstPinned = queue.receiveCalls.indexOf(pinnedTopic);
    expect(queue.receiveCalls.slice(firstPinned)).toEqual([pinnedTopic, pinnedTopic, pinnedTopic]);

    // Lowering maxConcurrency retires surplus pollers once their jobs finish.
    state.config = centralConfig({ maxConcurrency: 1, topics: [pinnedTopic] });
    await vi.advanceTimersByTimeAsync(20_000);
    queue.push(pinnedTopic, randomUUID(), randomUUID());
    for (const gate of gates.splice(0)) gate.resolve();
    await settle();
    expect(running).toBe(1);
    gates.splice(0).forEach((gate) => gate.resolve());
    await settle();
    expect(running).toBe(1);
    expect(maxRunning).toBe(3);
    gates.splice(0).forEach((gate) => gate.resolve());
    await settle();
    expect(queue.acked).toHaveLength(5);

    // Disabling the capability centrally stops polling.
    state.config = centralConfig({ enabledCapabilities: [], topics: [] });
    await vi.advanceTimersByTimeAsync(20_000);
    const calls = queue.receiveCalls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.receiveCalls.length).toBe(calls);
    await daemon.shutdown();
  });

  it("always polls its system topic and runs repo.sync through the repo cache with the job env", async () => {
    const systemTopic = `system-jobs-agent-${AGENT_ID}`;
    const repository = {
      provider: "gitlab" as const,
      fullPath: "group/app",
      cloneUrl: "https://gitlab.example/group/app.git",
    };
    const sync = vi.fn(async () => ({
      dir: "/cache/gitlab/group/app",
      cloned: true,
      fetched: false,
    }));
    const { api, queue, daemon } = setup({
      capabilities: [systemCapability, capability(async () => ({}))],
      // Review is disabled centrally; system is built in.
      config: centralConfig({ enabledCapabilities: [], topics: [systemTopic] }),
      repos: { sync } as unknown as RepoCache,
    });
    api.startJob.mockImplementation(async (id: string) => ({
      action: "run",
      job: job(id, { capability: "system", type: "repo.sync", payload: { repository } }),
      jobToken: { jobId: id, token: `job-token-${id}`, expiresIn: 900 },
    }));
    const id = randomUUID();
    queue.push(systemTopic, id);
    void daemon.run();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
    const [repo, options] = sync.mock.calls[0] as unknown as [unknown, { env: NodeJS.ProcessEnv }];
    expect(repo).toEqual(repository);
    expect(options.env.OMNIRALPH_JOB_TOKEN).toBe(`job-token-${id}`);
    expect(api.submitResult).toHaveBeenCalledWith(id, {
      result: { repository: "gitlab/group/app", cloned: true, fetched: false },
    });
    expect(queue.acked).toEqual([{ topic: systemTopic, message: { jobId: id } }]);
    await daemon.shutdown();
  });

  it("waits pollIntervalSeconds between empty polls", async () => {
    const { queue, daemon } = setup({ config: centralConfig({ pollIntervalSeconds: 7 }) });
    void daemon.run();
    await settle();
    expect(queue.receiveCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(queue.receiveCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.receiveCalls).toHaveLength(2);
    await daemon.shutdown();
  });

  it("updates job tokens from heartbeats", async () => {
    const id = randomUUID();
    const gate = deferred();
    let ctx: JobContext | undefined;
    const { state, queue, daemon } = setup({
      run: async (_j, c) => {
        ctx = c;
        await gate.promise;
        return {};
      },
    });
    queue.push("review-jobs", id);
    void daemon.run();
    await settle();
    expect(ctx?.jobToken()).toBe(`job-token-${id}`);
    state.config = centralConfig({ jobTokens: [{ jobId: id, token: "fresh", expiresIn: 900 }] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx?.jobToken()).toBe("fresh");
    expect(ctx?.env().OMNIRALPH_JOB_TOKEN).toBe("fresh");
    gate.resolve();
    await settle();
    await daemon.shutdown();
  });

  it("aborts a job listed in cancelJobIds and reports it canceled", async () => {
    const id = randomUUID();
    let signal: AbortSignal | undefined;
    const { api, state, queue, daemon } = setup({
      run: (_j, ctx) =>
        new Promise((_resolve, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        }),
    });
    api.submitFailure.mockResolvedValueOnce({ status: "canceled" });
    queue.push("review-jobs", id);
    void daemon.run();
    await settle();
    expect(signal?.aborted).toBe(false);

    state.config = centralConfig({ cancelJobIds: [id, randomUUID()] });
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(JobCanceled);
    expect(api.submitFailure).toHaveBeenCalledWith(id, { retryable: false, error: "canceled" });
    expect(queue.acked).toHaveLength(1);
    expect(daemon.status().runningJobIds).toEqual([]);
    await daemon.shutdown();
  });

  it("on SIGTERM stops polling, aborts jobs and exits without acknowledging them", async () => {
    const id = randomUUID();
    let signal: AbortSignal | undefined;
    const { api, queue, daemon } = setup({
      config: centralConfig({ maxConcurrency: 2 }),
      run: (_j, ctx) =>
        new Promise((_resolve, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    queue.push("review-jobs", id);
    const exit = daemon.run();
    await settle();
    const polls = queue.receiveCalls.length;
    const heartbeats = api.heartbeat.mock.calls.length;

    await daemon.shutdown();
    expect(await exit).toBe(0);
    expect(signal?.reason).toBeInstanceOf(ShutdownAbort);
    expect(api.submitFailure).not.toHaveBeenCalled();
    expect(api.submitResult).not.toHaveBeenCalled();
    expect(queue.acked).toEqual([]);
    expect(queue.unacked).toEqual([{ topic: "review-jobs", message: { jobId: id } }]);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(queue.receiveCalls.length).toBe(polls);
    expect(api.heartbeat.mock.calls.length).toBe(heartbeats);
  });

  it("on SIGTERM lets jobs finish within 60s and reports them", async () => {
    const id = randomUUID();
    const { api, queue, daemon } = setup({
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        return { done: true };
      },
    });
    queue.push("review-jobs", id);
    const exit = daemon.run();
    await settle();
    let exited = false;
    void exit.then(() => (exited = true));
    const shutdown = daemon.shutdown();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(exited).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;
    expect(await exit).toBe(0);
    expect(api.submitResult).toHaveBeenCalledWith(id, { result: { done: true } });
    expect(queue.acked).toHaveLength(1);
  });

  it("on SIGTERM gives up after 60s and leaves unfinished messages unacknowledged", async () => {
    const { api, queue, daemon } = setup({ run: () => new Promise(() => {}) });
    queue.push("review-jobs", randomUUID());
    const exit = daemon.run();
    await settle();
    let exited = false;
    void exit.then(() => (exited = true));
    void daemon.shutdown();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(exited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await exit).toBe(0);
    expect(queue.acked).toEqual([]);
    expect(api.submitResult).not.toHaveBeenCalled();
    expect(api.submitFailure).not.toHaveBeenCalled();
  });

  it("releases messages received after shutdown began without starting them", async () => {
    const { api, queue, daemon } = setup({});
    void daemon.run();
    await settle();
    await daemon.shutdown();
    // A receive that was already in flight delivers a message after the shutdown.
    queue.push("review-jobs", randomUUID());
    await queue
      .receive(
        "review-jobs",
        "agents",
        (m, meta) =>
          (daemon as unknown as { handleMessage: MessageHandler }).handleMessage(m, meta),
        { retry: (e) => (e as { directive?: RetryDirective }).directive },
      )
      .catch(() => {});
    expect(api.startJob).not.toHaveBeenCalled();
    expect(queue.rescheduled[0]?.directive).toEqual({ afterSeconds: 0 });
  });

  it("fail() stops everything and exits non-zero", async () => {
    const { queue, daemon } = setup({});
    const exit = daemon.run();
    await settle();
    daemon.fail(new Error("re-enrollment required"));
    expect(await exit).toBe(1);
    const polls = queue.receiveCalls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.receiveCalls.length).toBe(polls);
  });
});
