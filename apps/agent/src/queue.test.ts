import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerTokenDispatcher, createQueueReceiver } from "./queue.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

describe("queue client", () => {
  let server: Server;
  let base: string;
  const seen: Seen[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      req.resume();
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("sets the current access token on every request", async () => {
    let token = "access-1";
    const dispatcher = bearerTokenDispatcher(() => token);
    const init = (auth: string) =>
      ({ method: "POST", headers: { Authorization: auth }, dispatcher }) as unknown as RequestInit;
    await fetch(`${base}/x`, init("Bearer stale"));
    token = "access-2";
    await fetch(`${base}/x`, init("Bearer stale"));
    expect(seen.slice(-2).map((s) => s.headers.authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);
  });

  it("polls through the control panel's queue proxy with the current token", async () => {
    let token = "access-1";
    const receiver = createQueueReceiver(`${base}/prefix`, "iad1", () => token);
    const handler = async () => {};
    expect(await receiver.receive("review-jobs", "agents", handler, { limit: 1 })).toEqual({
      ok: false,
      reason: "empty",
    });
    token = "access-2";
    await receiver.receive("review-jobs", "agents", handler, { limit: 1 });
    const [first, second] = seen.slice(-2);
    expect(first).toMatchObject({
      method: "POST",
      url: "/prefix/api/agent/queue/iad1/api/v3/topic/review-jobs/consumer/agents",
    });
    expect(first?.headers.authorization).toBe("Bearer access-1");
    expect(second?.headers.authorization).toBe("Bearer access-2");
    // Deploymentless: no deployment pinning header.
    expect(first?.headers["vqs-deployment-id"]).toBeUndefined();
  });
});
