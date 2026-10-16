import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { api, ApiError, apiRequest, NETWORK_ERROR, UNEXPECTED_RESPONSE } from "./client";
import { ORGANIZATION_HEADER } from "./schemas";

const schema = z.object({ name: z.string() });

function respond(body: string, status = 200) {
  const fetchMock = vi.fn(
    async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  it("parses a 2xx response with the schema", async () => {
    const fetchMock = respond(JSON.stringify({ name: "build-01", extra: true }));
    await expect(apiRequest("/api/ui/harnesses/h1", schema)).resolves.toEqual({
      name: "build-01",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ui/harnesses/h1",
      expect.objectContaining({ method: "GET", body: undefined }),
    );
  });

  it("sends JSON bodies, search params and the organization header", async () => {
    const fetchMock = respond(JSON.stringify({ name: "x" }));
    await api.post("/api/ui/jobs", schema, {
      body: { a: 1 },
      params: { page: 2, status: undefined, q: "a b" },
      organizationId: "org-1",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ui/jobs?page=2&q=a+b");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      [ORGANIZATION_HEADER]: "org-1",
    });
  });

  it("throws the server's message, code and field errors on a 4xx", async () => {
    respond(
      JSON.stringify({
        error: "This action requires the admin role.",
        code: "forbidden",
        fieldErrors: { name: "Required" },
      }),
      403,
    );
    const error = await failure(apiRequest("/api/ui/x", schema));
    expect(error.message).toBe("This action requires the admin role.");
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
    expect(error.fieldErrors).toEqual({ name: "Required" });
  });

  it("throws the server's message on a 5xx", async () => {
    respond(JSON.stringify({ error: "Something went wrong. Try again." }), 500);
    const error = await failure(apiRequest("/api/ui/x", schema));
    expect(error).toMatchObject({ status: 500, message: "Something went wrong. Try again." });
  });

  it("throws a generic message on a 5xx that isn't JSON (a proxy's error page)", async () => {
    respond("<html>Bad gateway</html>", 502);
    const error = await failure(apiRequest("/api/ui/x", schema));
    expect(error).toMatchObject({ status: 502, message: UNEXPECTED_RESPONSE });
  });

  it("throws on invalid JSON in a 2xx", async () => {
    respond("{not json", 200);
    const error = await failure(apiRequest("/api/ui/x", schema));
    expect(error).toMatchObject({ status: 200, message: UNEXPECTED_RESPONSE });
  });

  it("throws when a 2xx doesn't match the schema", async () => {
    respond(JSON.stringify({ name: 3 }));
    const error = await failure(apiRequest("/api/ui/x", schema));
    expect(error.message).toBe(UNEXPECTED_RESPONSE);
  });

  it("throws a network error when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const error = await failure(apiRequest("/api/ui/x", schema));
    expect(error).toMatchObject({ status: 0, message: NETWORK_ERROR });
  });

  it("passes an abort through as is", async () => {
    const controller = new AbortController();
    const abort = new DOMException("Aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw abort;
      }),
    );
    await expect(apiRequest("/api/ui/x", schema, { signal: controller.signal })).rejects.toBe(
      abort,
    );
  });
});
