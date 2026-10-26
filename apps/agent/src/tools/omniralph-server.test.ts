import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTool, LinearTool, TaskType } from "@omniralph/tasks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchFn } from "../api.js";
import { silentLogger } from "../logger.js";
import {
  createOmniralphServer,
  offeredLinearTools,
  omniralphTools,
  type OmniralphServerOptions,
} from "./omniralph-server.js";

const SERVER = "https://omniralph.example.com";
const JOB = "job-1";
const BASE = `${SERVER}/api/agent/jobs/${JOB}`;

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}

/** A fake fetch answering with `respond`, recording every request. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: FetchFn = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Result = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

const resultText = (result: Result) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

describe("omniralph server", () => {
  let tmp: string;
  let controller: AbortController;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "omniralph-tools-test-"));
    controller = new AbortController();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function options(
    fetch: FetchFn,
    tools: AgentTool[] = ["post_activity", "ask_permission", "get_attachment"],
    taskType: TaskType = "query",
  ): OmniralphServerOptions {
    return {
      server: SERVER,
      jobId: JOB,
      sessionToken: () => "session-token",
      tools,
      taskType,
      tmpDir: tmp,
      signal: controller.signal,
      logger: silentLogger(),
      fetch,
      permissionTimeoutMs: 200,
      pollIntervalMs: 5,
    };
  }

  async function call(
    fetch: FetchFn,
    name: AgentTool,
    args: Record<string, unknown>,
  ): Promise<Result> {
    const definition = omniralphTools(options(fetch, [name])).find((t) => t.name === name);
    if (!definition) throw new Error(`${name} isn't offered`);
    return definition.handler(args as never, undefined);
  }

  /** Every request authenticated with the session token, never the lifecycle token. */
  function expectSessionToken(calls: Call[]): void {
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.authorization).toBe("Bearer session-token");
  }

  describe("tool list", () => {
    it("serves the listed tools as mcp__omniralph__<tool>", () => {
      const server = createOmniralphServer(
        options(fakeFetch(() => json({})).fn, ["post_activity"]),
      );
      expect(server?.allowedTools).toEqual(["mcp__omniralph__post_activity"]);
      expect(server?.config).toMatchObject({ type: "sdk", name: "omniralph" });
    });

    it("is null when the agent lists no agent tools", () => {
      expect(createOmniralphServer(options(fakeFetch(() => json({})).fn, []))).toBeNull();
    });

    it("never offers ship to query or review runs", () => {
      for (const taskType of ["query", "review"] as const) {
        const server = createOmniralphServer(
          options(fakeFetch(() => json({})).fn, ["ship", "post_activity"], taskType),
        );
        expect(server?.allowedTools).toEqual(["mcp__omniralph__post_activity"]);
      }
      expect(
        createOmniralphServer(options(fakeFetch(() => json({})).fn, ["ship"], "query")),
      ).toBeNull();
    });
  });

  describe("ship", () => {
    const outcome = { commitSha: "a".repeat(40), pushed: true, error: null };

    it("is offered on coding runs that can ship only (never query, review or story runs)", () => {
      const fetch = fakeFetch(() => json({})).fn;
      const tools = ["ship", "post_activity"] as AgentTool[];
      const listed = (taskType: TaskType, ship?: OmniralphServerOptions["ship"]) =>
        createOmniralphServer({ ...options(fetch, tools, taskType), ...(ship && { ship }) })
          ?.allowedTools;
      const handler = async () => outcome;
      expect(listed("coding", handler)).toEqual([
        "mcp__omniralph__post_activity",
        "mcp__omniralph__ship",
      ]);
      // A story run has no `ship` handler.
      expect(listed("coding")).toEqual(["mcp__omniralph__post_activity"]);
      for (const taskType of ["query", "review"] as const) {
        expect(listed(taskType, handler)).toEqual(["mcp__omniralph__post_activity"]);
      }
      // Not without the agent listing it.
      expect(
        createOmniralphServer({ ...options(fetch, ["post_activity"], "coding"), ship: handler })
          ?.allowedTools,
      ).toEqual(["mcp__omniralph__post_activity"]);
    });

    function shipTool(handler: NonNullable<OmniralphServerOptions["ship"]>) {
      const definition = omniralphTools({
        ...options(fakeFetch(() => json({})).fn, ["ship"], "coding"),
        ship: handler,
      }).find((t) => t.name === "ship");
      if (!definition) throw new Error("ship isn't offered");
      return definition;
    }

    it("hands the message, PR action and lease to the agent and returns its outcome", async () => {
      const asked: unknown[] = [];
      const result = await shipTool(async (request) => {
        asked.push(request);
        return outcome;
      }).handler(
        {
          message: "Fix it",
          pullRequest: { action: "open", title: "Fix it", body: "Fixes it." },
          forceWithLease: true,
        } as never,
        undefined,
      );
      expect(asked).toEqual([
        {
          message: "Fix it",
          pullRequest: { action: "open", title: "Fix it", body: "Fixes it." },
          forceWithLease: true,
        },
      ]);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(resultText(result))).toEqual(outcome);

      const bare = await shipTool(async (request) => {
        asked.push(request);
        return outcome;
      }).handler({ forceWithLease: false } as never, undefined);
      expect(asked[1]).toEqual({});
      expect(bare.isError).toBeUndefined();
    });

    it("returns a failed ship as a tool error with its outcome", async () => {
      const failed = { commitSha: null, pushed: false, error: "pushing the branch failed" };
      const result = await shipTool(async () => failed).handler({} as never, undefined);
      expect(result.isError).toBe(true);
      expect(JSON.parse(resultText(result))).toEqual(failed);

      const thrown = await shipTool(async () => {
        throw new Error("boom");
      }).handler({} as never, undefined);
      expect(thrown.isError).toBe(true);
      expect(resultText(thrown)).toBe("shipping failed: boom");
    });
  });

  describe("post_activity", () => {
    it("posts the activity with the session token", async () => {
      const fake = fakeFetch(() => json({ ok: true }));
      const result = await call(fake.fn, "post_activity", {
        type: "action",
        body: "Reading",
        parameter: "src/a.ts",
      });
      expect(result.isError).toBeUndefined();
      expect(fake.calls).toEqual([
        {
          url: `${BASE}/activities`,
          method: "POST",
          authorization: "Bearer session-token",
          body: { type: "action", body: "Reading", parameter: "src/a.ts", ephemeral: false },
        },
      ]);
    });

    it("returns a tool error on a 4xx/5xx", async () => {
      for (const status of [403, 502]) {
        const fake = fakeFetch(() => json({ error: "nope" }, status));
        const result = await call(fake.fn, "post_activity", { type: "thought", body: "Hm" });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain("posting the activity failed");
      }
    });

    it("returns a tool error when the network fails", async () => {
      const fake = fakeFetch(() => {
        throw new TypeError("fetch failed");
      });
      const result = await call(fake.fn, "post_activity", { type: "thought", body: "Hm" });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("fetch failed");
    });
  });

  describe("ask_permission", () => {
    it("asks, polls until answered and returns the answer", async () => {
      let polls = 0;
      const fake = fakeFetch((c) => {
        if (c.method === "POST") return json({ ok: true });
        polls++;
        return json({ status: polls < 3 ? "pending" : "allowed", answeredBy: "Ada" });
      });
      const result = await call(fake.fn, "ask_permission", {
        tool: "deploy",
        detail: "staging",
      });
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toBe("allowed");
      expect(fake.calls[0]).toMatchObject({
        url: `${BASE}/permissions`,
        method: "POST",
        body: { tool: "deploy", detail: "staging", timeoutSeconds: 1 },
      });
      const requestId = (fake.calls[0]?.body as { requestId: string }).requestId;
      expect(fake.calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(
        Array(3).fill(`GET ${BASE}/permissions/${requestId}`),
      );
      expectSessionToken(fake.calls);
    });

    it("returns denied and expired answers as they come", async () => {
      for (const status of ["denied", "expired"]) {
        const fake = fakeFetch((c) => (c.method === "POST" ? json({}) : json({ status })));
        expect(resultText(await call(fake.fn, "ask_permission", { tool: "x", detail: "" }))).toBe(
          status,
        );
      }
    });

    it("returns expired and closes the question when nobody answers in time", async () => {
      const fake = fakeFetch((c) =>
        c.method === "POST" || c.method === "DELETE" ? json({}) : json({ status: "pending" }),
      );
      const result = await call(fake.fn, "ask_permission", { tool: "x", detail: "" });
      expect(resultText(result)).toBe("expired");
      expect(fake.calls.at(-1)?.method).toBe("DELETE");
      expectSessionToken(fake.calls);
    });

    it("returns denied when the run is aborted", async () => {
      const fake = fakeFetch((c) => {
        if (c.method === "GET") controller.abort(new Error("cancelled"));
        return c.method === "GET" ? json({ status: "pending" }) : json({});
      });
      const result = await call(fake.fn, "ask_permission", { tool: "x", detail: "" });
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toBe("denied");
    });

    it("returns denied without asking once the run is aborted", async () => {
      controller.abort();
      const fake = fakeFetch(() => json({}));
      const result = await call(fake.fn, "ask_permission", { tool: "x", detail: "" });
      expect(resultText(result)).toBe("denied");
      expect(fake.calls).toEqual([]);
    });

    it("returns a tool error when the question can't be asked", async () => {
      const fake = fakeFetch(() => json({ error: "forbidden" }, 403));
      const result = await call(fake.fn, "ask_permission", { tool: "x", detail: "" });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("asking for permission failed");
    });

    it("returns a tool error when the answer can't be read", async () => {
      const fake = fakeFetch((c) => {
        if (c.method === "POST" || c.method === "DELETE") return json({});
        throw new TypeError("fetch failed");
      });
      const result = await call(fake.fn, "ask_permission", { tool: "x", detail: "" });
      expect(result.isError).toBe(true);
      expect(fake.calls.at(-1)?.method).toBe("DELETE");
    });
  });

  describe("get_attachment", () => {
    it("saves the attachment under the run's temp directory and returns its path", async () => {
      const fake = fakeFetch(
        () => new Response("PNGDATA", { headers: { "content-type": "image/png" } }),
      );
      const result = await call(fake.fn, "get_attachment", { attachmentId: "a".repeat(32) });
      expect(result.isError).toBeUndefined();
      const file = resultText(result);
      expect(path.dirname(file)).toBe(path.join(tmp, "attachments"));
      expect(path.extname(file)).toBe(".png");
      expect(await readFile(file, "utf8")).toBe("PNGDATA");
      expect(fake.calls).toMatchObject([
        { url: `${BASE}/attachments/${"a".repeat(32)}`, method: "GET" },
      ]);
      expectSessionToken(fake.calls);
    });

    it("returns a tool error on a 4xx/5xx or a network failure", async () => {
      const notFound = fakeFetch(() => json({ error: "not_found" }, 404));
      const missing = await call(notFound.fn, "get_attachment", { attachmentId: "abc" });
      expect(missing.isError).toBe(true);
      expect(resultText(missing)).toContain("HTTP 404");

      const down = fakeFetch(() => {
        throw new TypeError("fetch failed");
      });
      const failed = await call(down.fn, "get_attachment", { attachmentId: "abc" });
      expect(failed.isError).toBe(true);
      expect(resultText(failed)).toContain("fetch failed");
    });
  });

  describe("Linear tools", () => {
    const LINEAR = `${SERVER}/api/agent/runs/${JOB}/linear`;
    const issue = {
      id: "i1",
      identifier: "ENG-7",
      title: "Login fails",
      description: "Steps",
      url: "https://linear.app/acme/issue/ENG-7",
      team: "ENG",
      state: "Todo",
      stateType: "unstarted",
      priority: 2,
      labels: ["bug"],
    };

    function linearOptions(fetch: FetchFn, linearTools: LinearTool[]): OmniralphServerOptions {
      return { ...options(fetch, []), linearTools };
    }

    async function callLinear(
      fetch: FetchFn,
      name: LinearTool,
      args: Record<string, unknown>,
    ): Promise<Result> {
      const definition = omniralphTools(linearOptions(fetch, [name])).find((t) => t.name === name);
      if (!definition) throw new Error(`${name} isn't offered`);
      return definition.handler(args as never, undefined);
    }

    it("offers the agent's Linear tools only when the task turns on linearRead", () => {
      const tools = { linear: ["linear_get_issue", "linear_get_issue"] as LinearTool[] };
      expect(offeredLinearTools(tools, { linearRead: true })).toEqual(["linear_get_issue"]);
      expect(offeredLinearTools(tools, { linearRead: false })).toEqual([]);
    });

    it("serves them as mcp__omniralph__<tool>, even without agent tools", () => {
      const server = createOmniralphServer(
        linearOptions(fakeFetch(() => json({})).fn, ["linear_get_issue", "linear_get_document"]),
      );
      expect(server?.allowedTools).toEqual([
        "mcp__omniralph__linear_get_issue",
        "mcp__omniralph__linear_get_document",
      ]);
      expect(createOmniralphServer(linearOptions(fakeFetch(() => json({})).fn, []))).toBeNull();
    });

    it("reads an issue, its comments and a document as JSON with the session token", async () => {
      const comments = { comments: [{ body: "hi", author: "Bo" }], omitted: 0 };
      const document = {
        id: "d1",
        title: "PRD",
        content: "# PRD",
        url: "https://linear.app/acme/document/prd-d1",
        updatedAt: "2026-10-01T00:00:00.000Z",
      };
      const { fn, calls } = fakeFetch((c) =>
        c.url.endsWith("/comments")
          ? json(comments)
          : c.url.includes("/documents/")
            ? json({ document })
            : json({ issue }),
      );
      const got = await callLinear(fn, "linear_get_issue", { issueId: "ENG-7" });
      expect(got.isError).toBeFalsy();
      expect(JSON.parse(resultText(got))).toEqual({ issue });
      expect(
        JSON.parse(resultText(await callLinear(fn, "linear_list_comments", { issueId: "ENG-7" }))),
      ).toEqual(comments);
      expect(
        JSON.parse(
          resultText(await callLinear(fn, "linear_get_document", { documentId: "prd-d1" })),
        ),
      ).toEqual({ document });
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["GET", `${LINEAR}/issues/ENG-7`],
        ["GET", `${LINEAR}/issues/ENG-7/comments`],
        ["GET", `${LINEAR}/documents/prd-d1`],
      ]);
      expectSessionToken(calls);
    });

    it("searches issues with the query and result count in the URL", async () => {
      const { fn, calls } = fakeFetch(() => json({ issues: [issue] }));
      const result = await callLinear(fn, "linear_search_issues", { query: "login & auth" });
      expect(JSON.parse(resultText(result))).toEqual({ issues: [issue] });
      await callLinear(fn, "linear_search_issues", { query: "x", first: 3 });
      expect(calls.map((c) => c.url)).toEqual([
        `${LINEAR}/issues?query=login+%26+auth`,
        `${LINEAR}/issues?query=x&first=3`,
      ]);
      expectSessionToken(calls);
    });

    it("returns a tool error on an error status, an invalid body or a network failure", async () => {
      const refused = fakeFetch(() => json({ error: "linear_tool_not_allowed" }, 403));
      const denied = await callLinear(refused.fn, "linear_get_issue", { issueId: "ENG-7" });
      expect(denied.isError).toBe(true);
      expect(resultText(denied)).toContain("linear_tool_not_allowed");

      const invalid = fakeFetch(() => json({ nope: true }));
      const bad = await callLinear(invalid.fn, "linear_get_issue", { issueId: "ENG-7" });
      expect(bad.isError).toBe(true);
      expect(resultText(bad)).toContain("invalid body");

      const down = fakeFetch(() => {
        throw new TypeError("fetch failed");
      });
      const failed = await callLinear(down.fn, "linear_search_issues", { query: "x" });
      expect(failed.isError).toBe(true);
      expect(resultText(failed)).toContain("fetch failed");
    });
  });
});
