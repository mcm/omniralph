import type { ChatThread } from "@omniralph/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTarget } from "@/lib/ralph/conversation";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  /** Tasks passed to `after()`; null: called outside a request (it throws). */
  after: [] as Array<() => Promise<void>> | null,
  created: true,
  woken: [] as string[],
}));
vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    if (!state.after) throw new Error("`after` was called outside a request scope");
    state.after.push(task);
  },
}));
vi.mock("@omniralph/db", () => ({
  threadRunOf: async () => ({ id: "map-1", chatThreadId: "thread-1", organizationId: "org-1" }),
  recordRunEvent: async () => ({ created: state.created, event: null }),
}));
vi.mock("./agent/wake", () => ({
  defaultWakeDeps: async () => ({ deps: true }),
  processThreadRunEvents: async (_deps: unknown, chatThreadId: string) => {
    state.woken.push(chatThreadId);
    return { status: "processed", events: 1, posted: 1 };
  },
}));

const { recordChatRunEvent } = await import("./run-events");

const target = {
  channel: { db: {} },
  thread: { id: "thread-1" } as ChatThread,
  allowedHosts: ["omniralph.example.com"],
} as unknown as ChatTarget;

const record = () =>
  recordChatRunEvent(target, {
    organizationId: "org-1",
    run: { jobId: "job-1" },
    kind: "response",
    body: { text: "The answer." },
    key: "response",
  });

beforeEach(() => {
  state.after = [];
  state.created = true;
  state.woken = [];
});

describe("recordChatRunEvent", () => {
  it("wakes the responder for the thread after the response when it records an event", async () => {
    expect(await record()).toBe(true);
    expect(state.woken).toEqual([]);
    expect(state.after).toHaveLength(1);

    await state.after![0]!();

    expect(state.woken).toEqual(["thread-1"]);
  });

  it("schedules nothing for an event recorded already", async () => {
    state.created = false;
    expect(await record()).toBe(false);
    expect(state.after).toEqual([]);
  });

  it("leaves the event to the cron outside a request", async () => {
    state.after = null;
    expect(await record()).toBe(true);
    expect(state.woken).toEqual([]);
  });
});
