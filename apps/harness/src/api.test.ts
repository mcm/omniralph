import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  enroll,
  exchangeRefreshToken,
  HttpControlPanelApi,
  type FetchFn,
} from "./api.js";

const SERVER = "https://omniralph.example";

function apiWith(respond: (init: RequestInit) => Response | Promise<Response>) {
  const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
    respond(init ?? {}),
  );
  const api = new HttpControlPanelApi(SERVER, async () => "access", fetchFn as unknown as FetchFn);
  return { api, fetchFn };
}

describe("HttpControlPanelApi.claim", () => {
  it("posts the pools to /api/harness/claim and returns the claimed job", async () => {
    const id = randomUUID();
    const start = {
      action: "run",
      job: {
        id,
        type: "review.run",
        taskType: "review",
        pool: "short",
        taskId: null,
        repositoryId: null,
        payload: {},
        deliveryCount: 1,
      },
      jobToken: { jobId: id, token: "job-token", expiresIn: 900 },
    };
    const { api, fetchFn } = apiWith(() => Response.json(start));
    // A token without a kind is a legacy job's single token.
    expect(await api.claim({ pools: ["short"] })).toEqual({
      ...start,
      jobToken: { ...start.jobToken, kind: "legacy" },
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/api/harness/claim`);
    expect(JSON.parse(String(init?.body))).toEqual({ pools: ["short"] });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
  });

  it("parses a run-spec job's run spec, and rejects a run-spec job without one", async () => {
    const id = randomUUID();
    const lifecycle = { jobId: id, token: "lifecycle", expiresIn: 900, kind: "lifecycle" };
    const session = { jobId: id, token: "session", expiresIn: 900, kind: "session" };
    const runSpec = {
      jobId: id,
      taskType: "query",
      pool: "short",
      agent: { id: "builtin:a", name: "A", systemPrompt: "You answer.", taskTypes: ["query"] },
      task: {
        id: "builtin:t",
        name: "T",
        taskType: "query",
        agentId: "builtin:a",
        triggers: ["chat.request"],
        promptTemplate: "{{question}}",
        sink: "chat-thread",
      },
      trigger: { kind: "chat.request", context: { question: "Why?" } },
      repository: null,
      ref: null,
      requireCheckout: false,
      tools: { allowedTools: [], disallowedTools: ["WebFetch"] },
      model: "sonnet",
      fallbackModel: null,
      tokenBudget: 1000,
      tokens: { lifecycle, session },
    };
    const start = {
      action: "run",
      job: {
        id,
        type: "task.run",
        taskType: "query",
        pool: "short",
        taskId: "builtin:t",
        repositoryId: null,
        payload: {},
        deliveryCount: 1,
      },
      runSpec,
      jobToken: lifecycle,
      sessionToken: session,
    };
    const parsed = await apiWith(() => Response.json(start)).api.claim({ pools: ["short"] });
    expect(parsed).toMatchObject(start);
    if (parsed?.action !== "run") throw new Error("expected run");
    // Definition defaults are filled in.
    expect(parsed.runSpec?.agent.tools).toEqual({
      builtin: [],
      harness: [],
      linear: [],
      mcpServers: [],
    });

    const { runSpec: _, ...withoutSpec } = start;
    await expect(
      apiWith(() => Response.json(withoutSpec)).api.claim({ pools: ["short"] }),
    ).rejects.toThrow();
    const legacyWithSpec = { ...start, job: { ...start.job, taskId: null } };
    await expect(
      apiWith(() => Response.json(legacyWithSpec)).api.claim({ pools: ["short"] }),
    ).rejects.toThrow();
  });

  it("returns null on 204 (nothing to claim)", async () => {
    const { api } = apiWith(() => new Response(null, { status: 204 }));
    expect(await api.claim({ pools: ["short"] })).toBeNull();
  });

  it("throws ApiError on an error response", async () => {
    const { api } = apiWith(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(api.claim({ pools: ["short"] })).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    await expect(api.claim({ pools: ["short"] })).rejects.toBeInstanceOf(ApiError);
  });

  it("aborts the request with the caller's signal", async () => {
    const { api, fetchFn } = apiWith(
      (init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    const controller = new AbortController();
    const claim = api.claim({ pools: ["short"] }, controller.signal);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const reason = new Error("claim aborted");
    controller.abort(reason);
    await expect(claim).rejects.toBe(reason);
  });
});

describe("harness API paths", () => {
  it("calls only /api/harness/*", async () => {
    const { api, fetchFn } = apiWith(() => Response.json({}));
    const ignore = () => undefined;
    await enroll(
      SERVER,
      { enrollmentToken: "e", name: "n", version: "1.0.0" },
      fetchFn as unknown as FetchFn,
    ).catch(ignore);
    await exchangeRefreshToken(SERVER, "r", fetchFn as unknown as FetchFn).catch(ignore);
    await api.heartbeat({} as never).catch(ignore);
    await api.claim({ pools: ["short"] }).catch(ignore);
    await api.submitResult("job-1", {} as never).catch(ignore);
    await api.submitFailure("job-1", {} as never).catch(ignore);
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      `${SERVER}/api/harness/enroll`,
      `${SERVER}/api/harness/token`,
      `${SERVER}/api/harness/heartbeat`,
      `${SERVER}/api/harness/claim`,
      `${SERVER}/api/harness/jobs/job-1/result`,
      `${SERVER}/api/harness/jobs/job-1/fail`,
    ]);
  });
});
