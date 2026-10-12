import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
}));
vi.mock("@/lib/chat/agent/wake", () => ({
  defaultWakeDeps: async () => ({ deployment: true }),
  processPendingRunEvents: async (deps: unknown) => {
    state.calls.push(deps);
    return { processed: 2, locked: 1 };
  },
}));

process.env.CRON_SECRET = "cron-secret";
const { GET } = await import("./chat-run-events/route");

const cron = () =>
  GET(
    new Request("http://localhost/api/cron/chat-run-events", {
      headers: { authorization: "Bearer cron-secret" },
    }),
  );

beforeEach(() => {
  state.calls = [];
});

describe("GET /api/cron/chat-run-events", () => {
  it("requires the cron secret", async () => {
    const res = await GET(new Request("http://localhost/api/cron/chat-run-events"));
    expect(res.status).toBe(401);
    const wrong = await GET(
      new Request("http://localhost/api/cron/chat-run-events", {
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(wrong.status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it("wakes the threads with run events left pending, with the deployment's bot and model", async () => {
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 2, locked: 1 });
    expect(state.calls).toEqual([{ deployment: true }]);
  });
});
