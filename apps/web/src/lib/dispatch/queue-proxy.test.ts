import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseQueueRequest, proxyQueueRequest, type QueueProxyOptions } from "./queue-proxy";

const AGENT_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const OWN_TOPIC = `review-jobs-agent-${AGENT_ID}`;
const BASE = "https://omniralph.test/api/agent/queue";
const UPSTREAM = "https://iad1.vercel-queue.com";
const BOUNDARY = "vqs-test";
const MULTIPART =
  `--${BOUNDARY}\r\nContent-Type: application/json\r\nVqs-Message-Id: 0-1\r\n\r\n` +
  `{"jobId":"${AGENT_ID}"}\r\n--${BOUNDARY}--\r\n`;

interface Upstream {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

const upstreamCalls: Upstream[] = [];
const server = setupServer(
  http.all(`${UPSTREAM}/*`, async ({ request }) => {
    upstreamCalls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });
    if (request.method === "POST") {
      return new HttpResponse(MULTIPART, {
        headers: {
          "Content-Type": `multipart/mixed; boundary=${BOUNDARY}`,
          "Set-Cookie": "upstream=1",
          "Vqs-Request-Id": "req-1",
        },
      });
    }
    return new HttpResponse(null, { status: 204 });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
beforeEach(() => {
  upstreamCalls.length = 0;
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const getOidcToken = vi.fn(async () => "oidc-token");

function options(overrides: Partial<QueueProxyOptions> = {}): QueueProxyOptions {
  return {
    regions: ["iad1"],
    allowedTopics: ["review-jobs", OWN_TOPIC],
    getOidcToken,
    ...overrides,
  };
}

const receivePath = (topic = "review-jobs", group = "agents", region = "iad1") =>
  `${BASE}/${region}/api/v3/topic/${topic}/consumer/${group}`;
const leasePath = (handle = "rh-abc.123", topic = "review-jobs") =>
  `${receivePath(topic)}/lease/${handle}`;

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    method: "POST",
    ...init,
    headers: { authorization: "Bearer agent-access-token", ...init.headers },
  });
}

async function expectForbidden(res: Response) {
  expect(res.status).toBe(403);
  expect(upstreamCalls).toHaveLength(0);
}

describe("parseQueueRequest", () => {
  it("recognises the three operations", () => {
    expect(parseQueueRequest("POST", receivePath())?.operation).toBe("receive");
    expect(parseQueueRequest("DELETE", leasePath())?.operation).toBe("acknowledge");
    expect(parseQueueRequest("PATCH", leasePath())?.operation).toBe("extendLease");
  });

  it("rejects other method/path combinations", () => {
    expect(parseQueueRequest("GET", receivePath())).toBeNull();
    expect(parseQueueRequest("DELETE", receivePath())).toBeNull();
    expect(parseQueueRequest("POST", leasePath())).toBeNull();
    expect(parseQueueRequest("PUT", leasePath())).toBeNull();
  });
});

describe("proxyQueueRequest", () => {
  it("forwards a receive with the OIDC token and streams the multipart response", async () => {
    const res = await proxyQueueRequest(
      request(receivePath(), {
        headers: {
          accept: "multipart/mixed",
          "vqs-visibility-timeout-seconds": "300",
          "vqs-max-messages": "1",
        },
      }),
      options(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`multipart/mixed; boundary=${BOUNDARY}`);
    expect(res.headers.get("vqs-request-id")).toBe("req-1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe(MULTIPART);

    expect(upstreamCalls).toHaveLength(1);
    const [call] = upstreamCalls;
    expect(call!.method).toBe("POST");
    expect(call!.url).toBe(`${UPSTREAM}/api/v3/topic/review-jobs/consumer/agents`);
    expect(call!.headers.get("authorization")).toBe("Bearer oidc-token");
    expect(call!.headers.get("accept")).toBe("multipart/mixed");
    expect(call!.headers.get("vqs-visibility-timeout-seconds")).toBe("300");
    expect(call!.headers.get("vqs-max-messages")).toBe("1");
  });

  it("forwards acknowledge and extend-lease on the agent's own topic", async () => {
    const ack = await proxyQueueRequest(
      request(leasePath("rh%3D1", OWN_TOPIC), { method: "DELETE" }),
      options(),
    );
    expect(ack.status).toBe(204);
    const extend = await proxyQueueRequest(
      request(leasePath("rh%3D1", OWN_TOPIC), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibilityTimeoutSeconds: 3600 }),
      }),
      options(),
    );
    expect(extend.status).toBe(204);
    expect(upstreamCalls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["DELETE", `${UPSTREAM}/api/v3/topic/${OWN_TOPIC}/consumer/agents/lease/rh%3D1`, ""],
      [
        "PATCH",
        `${UPSTREAM}/api/v3/topic/${OWN_TOPIC}/consumer/agents/lease/rh%3D1`,
        '{"visibilityTimeoutSeconds":3600}',
      ],
    ]);
    expect(upstreamCalls[1]!.headers.get("content-type")).toBe("application/json");
  });

  it("denies other operations (send, receive by ID, wrong method)", async () => {
    // Publishing (POST /api/v3/topic/<topic>) is the control panel's job only.
    await expectForbidden(
      await proxyQueueRequest(
        request(`${BASE}/iad1/api/v3/topic/review-jobs`, { body: "{}" }),
        options(),
      ),
    );
    await expectForbidden(await proxyQueueRequest(request(`${receivePath()}/id/0-1`), options()));
    await expectForbidden(
      await proxyQueueRequest(request(receivePath(), { method: "GET" }), options()),
    );
    await expectForbidden(
      await proxyQueueRequest(request(receivePath(), { method: "PUT" }), options()),
    );
    await expectForbidden(
      await proxyQueueRequest(request(leasePath(), { method: "POST" }), options()),
    );
  });

  it("denies topics the agent may not read", async () => {
    await expectForbidden(
      await proxyQueueRequest(
        request(receivePath("review-jobs-agent-00000000-0000-4000-8000-000000000000")),
        options(),
      ),
    );
    await expectForbidden(await proxyQueueRequest(request(receivePath("ralph-jobs")), options()));
    await expectForbidden(
      await proxyQueueRequest(
        request(leasePath("rh", "ralph-jobs"), { method: "DELETE" }),
        options(),
      ),
    );
  });

  it("denies consumer groups other than agents", async () => {
    await expectForbidden(
      await proxyQueueRequest(request(receivePath("review-jobs", "other")), options()),
    );
  });

  it("denies regions outside QUEUE_REGIONS", async () => {
    await expectForbidden(
      await proxyQueueRequest(request(receivePath("review-jobs", "agents", "sfo1")), options()),
    );
    // Hostname injection through the region segment.
    await expectForbidden(
      await proxyQueueRequest(
        request(receivePath("review-jobs", "agents", "evil.example.com%2F")),
        options({ regions: ["iad1", "evil.example.com%2F"] }),
      ),
    );
  });

  it("denies traversal and encoded slashes", async () => {
    const attempts = [
      `${BASE}/iad1/api/v3/topic/review-jobs/consumer/agents/lease/../../../../topic/x`,
      `${BASE}/iad1/api/v3/topic/review-jobs/consumer/agents/lease/%2e%2e%2fx`,
      `${BASE}/iad1/api/v3/topic/review-jobs%2Fconsumer%2Fagents`,
      `${BASE}/iad1/api/v3/topic/review-jobs/consumer/agents%2F..%2F..%2Fother`,
      `${BASE}/iad1/api/v3/topic/review-jobs/consumer/agents/lease/a%2Fb`,
      `${BASE}/iad1/api/v3/topic/review-jobs/consumer/agents/lease/a%5Cb`,
      `${BASE}/iad1/api/v3/topic/review-jobs/consumer/agents?x=1`,
      // `Request` normalises dot segments; the result must still be rejected.
      `${BASE}/../../../api/v3/topic/review-jobs/consumer/agents`,
      `${BASE}/iad1/%2e%2e/sfo1/api/v3/topic/review-jobs/consumer/agents`,
    ];
    for (const url of attempts) {
      const method = url.includes("/lease/") ? "DELETE" : "POST";
      expect(parseQueueRequest(method, url), url).toBeNull();
      await expectForbidden(await proxyQueueRequest(request(url, { method }), options()));
    }
  });

  it("strips the agent's token and non-allowlisted headers", async () => {
    await proxyQueueRequest(
      request(receivePath(), {
        headers: {
          accept: "multipart/mixed",
          cookie: "session=1",
          host: "evil.example.com",
          "x-forwarded-host": "evil.example.com",
          "x-vercel-oidc-token": "spoofed",
          "vqs-deployment-id": "dpl_1",
        },
      }),
      options(),
    );
    const headers = upstreamCalls[0]!.headers;
    expect(headers.get("authorization")).toBe("Bearer oidc-token");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-forwarded-host")).toBeNull();
    expect(headers.get("x-vercel-oidc-token")).toBeNull();
    expect(headers.get("vqs-deployment-id")).toBe("dpl_1");
    expect(JSON.stringify([...headers.values()])).not.toContain("agent-access-token");
  });

  it("never follows upstream redirects", async () => {
    const followed = vi.fn();
    server.use(
      http.all(`${UPSTREAM}/*`, () => HttpResponse.redirect("https://evil.example.com/steal", 307)),
      http.all("https://evil.example.com/*", () => {
        followed();
        return new HttpResponse("secret");
      }),
    );
    const res = await proxyQueueRequest(request(receivePath()), options());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_redirect" });
    expect(followed).not.toHaveBeenCalled();
  });

  it("rejects bodies over 64 KB", async () => {
    const big = JSON.stringify({ pad: "x".repeat(70 * 1024) });
    const res = await proxyQueueRequest(
      request(leasePath(), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: big,
      }),
      options(),
    );
    expect(res.status).toBe(413);
    expect(upstreamCalls).toHaveLength(0);

    // Without a Content-Length header (streamed body).
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 70; i++) controller.enqueue(encoder.encode("x".repeat(1024)));
        controller.close();
      },
    });
    const streamed = await proxyQueueRequest(
      new Request(leasePath(), { method: "PATCH", body: stream, duplex: "half" } as RequestInit),
      options(),
    );
    expect(streamed.status).toBe(413);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("returns 503 when no OIDC token is available", async () => {
    const res = await proxyQueueRequest(
      request(receivePath()),
      options({
        getOidcToken: async () => {
          throw new Error("no token");
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
  });
});
