import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessTool, TaskType } from "@omniralph/tasks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchFn } from "../api.js";
import { silentLogger } from "../logger.js";
import {
  createOmniralphServer,
  omniralphTools,
  type OmniralphServerOptions,
} from "./omniralph-server.js";

const SERVER = "https://omniralph.example.com";
const JOB = "job-1";
const BASE = `${SERVER}/api/harness/jobs/${JOB}`;

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
    tools: HarnessTool[] = ["post_activity", "ask_permission", "get_attachment"],
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
    name: HarnessTool,
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

    it("is null when the agent lists no harness tools", () => {
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
});
