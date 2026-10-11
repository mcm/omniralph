import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiError, HttpControlPanelApi, type FetchFn } from "./api.js";

const SERVER = "https://omniralph.example";

function apiWith(respond: (init: RequestInit) => Response | Promise<Response>) {
  const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
    respond(init ?? {}),
  );
  const api = new HttpControlPanelApi(SERVER, async () => "access", fetchFn as unknown as FetchFn);
  return { api, fetchFn };
}

describe("HttpControlPanelApi.claim", () => {
  it("posts the capabilities to /api/agent/claim and returns the claimed job", async () => {
    const id = randomUUID();
    const start = {
      action: "run",
      job: {
        id,
        capability: "review",
        type: "review.run",
        repositoryId: null,
        payload: {},
        deliveryCount: 1,
      },
      jobToken: { jobId: id, token: "job-token", expiresIn: 900 },
    };
    const { api, fetchFn } = apiWith(() => Response.json(start));
    expect(await api.claim({ capabilities: ["review"] })).toEqual(start);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/api/agent/claim`);
    expect(JSON.parse(String(init?.body))).toEqual({ capabilities: ["review"] });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
  });

  it("returns null on 204 (nothing to claim)", async () => {
    const { api } = apiWith(() => new Response(null, { status: 204 }));
    expect(await api.claim({ capabilities: ["review"] })).toBeNull();
  });

  it("throws ApiError on an error response", async () => {
    const { api } = apiWith(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(api.claim({ capabilities: ["review"] })).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    await expect(api.claim({ capabilities: ["review"] })).rejects.toBeInstanceOf(ApiError);
  });

  it("aborts the request with the caller's signal", async () => {
    const { api, fetchFn } = apiWith(
      (init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    const controller = new AbortController();
    const claim = api.claim({ capabilities: ["review"] }, controller.signal);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const reason = new Error("claim aborted");
    controller.abort(reason);
    await expect(claim).rejects.toBe(reason);
  });
});
