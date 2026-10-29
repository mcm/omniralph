import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isUnmatched, probePaths, unservedApiRoutes } from "./api-routes";

const ID = "00000000-0000-4000-8000-000000000000";

describe("probePaths", () => {
  it("fills dynamic segments, drops route groups and optional catch-alls, skips other files", () => {
    expect(
      probePaths([
        "api/ui/runs/[id]/attempts/[attemptId]/transcript/route.ts",
        "api/ui/runs/route.ts",
        "api/ui/runs/runs-api.test.ts",
        "api/ui/(group)/files/[...path]/route.ts",
        "api/ui/docs/[[...slug]]/route.ts",
        "api/ui/runs/[id]",
      ]),
    ).toEqual([
      "/api/ui/docs",
      `/api/ui/files/${ID}`,
      "/api/ui/runs",
      `/api/ui/runs/${ID}/attempts/${ID}/transcript`,
    ]);
  });
});

describe("isUnmatched", () => {
  it("is Next's HTML not-found page, never a handler's answer", () => {
    expect(isUnmatched(404, "text/html; charset=utf-8")).toBe(true);
    expect(isUnmatched(404, "application/json")).toBe(false);
    expect(isUnmatched(401, "application/json")).toBe(false);
    expect(isUnmatched(405, null)).toBe(false);
    expect(isUnmatched(200, "text/html")).toBe(false);
  });
});

describe("unservedApiRoutes", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("lists the paths answered with Next's not-found page, sending a session cookie", async () => {
    const cookies = new Set<string | undefined>();
    server = createServer((request, response) => {
      cookies.add(request.headers.cookie);
      if (request.url?.endsWith("/session")) {
        response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        response.end("<!DOCTYPE html><title>404</title>");
      } else {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":"unauthenticated"}');
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const paths = [
      "/api/ui/runs",
      `/api/ui/runs/${ID}`,
      `/api/ui/runs/${ID}/session`,
      `/api/ui/chats/${ID}/session`,
      "/api/ui/repos",
    ];
    expect(await unservedApiRoutes(`http://127.0.0.1:${port}`, "/unused", paths)).toEqual([
      `/api/ui/chats/${ID}/session`,
      `/api/ui/runs/${ID}/session`,
    ]);
    expect([...cookies]).toEqual(["authjs.session-token=probe"]);
  });
});
