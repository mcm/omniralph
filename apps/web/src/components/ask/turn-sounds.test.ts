import { QueryClient } from "@tanstack/react-query";
import type * as OmniralphUi from "@omniralph/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskTurnRequest } from "@/lib/ask/stream-client";
import { omMessage } from "./test-fixtures";
import { runAskTurn } from "./turn";

const mocks = vi.hoisted(() => ({
  play: vi.fn(),
  events: [] as unknown[],
  fails: false,
  toast: vi.fn(),
}));
vi.mock("@/lib/sound/player", () => ({ sounds: { play: mocks.play } }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: mocks.toast,
}));
vi.mock("@/lib/ask/stream-client", () => ({
  streamAskTurn: async ({ onEvent }: AskTurnRequest) => {
    for (const event of mocks.events) onEvent(event as Parameters<typeof onEvent>[0]);
    if (mocks.fails) throw new Error("network");
  },
}));

afterEach(() => {
  mocks.play.mockReset();
  mocks.events = [];
  mocks.fails = false;
});

const CHAT_ID = "c1";
const userMessage = omMessage({ id: "u1", author: "user", status: "complete", markdown: "Hi" });
const reply = (status: "streaming" | "complete") =>
  omMessage({ id: "m1", author: "om", status, markdown: "Hello" });

function send() {
  const client = new QueryClient();
  client.setQueryData(["chat", CHAT_ID], {
    pages: [{ chat: null, messages: [], activity: null, nextBefore: null }],
    pageParams: [undefined],
  });
  return runAskTurn({
    client,
    chatKey: (id) => ["chat", id],
    chatId: CHAT_ID,
    path: `/api/ui/ask/chats/${CHAT_ID}/messages`,
    body: { text: "Hi" },
    text: "Hi",
    organizationId: "o1",
  });
}

describe("an Ask turn's sounds", () => {
  it("plays send once the message is stored, and receive once Om's reply is done", async () => {
    const order: string[] = [];
    mocks.play.mockImplementation((cue: string) => order.push(cue));
    mocks.events = [
      { event: "message", message: userMessage },
      { event: "message", message: reply("streaming") },
      { event: "delta", messageId: "m1", text: " there" },
      { event: "message", message: reply("complete") },
      { event: "done" },
    ];
    expect(await send()).toBe("sent");
    expect(order).toEqual(["send", "receive"]);
  });

  it("plays no receive for a reply still streaming when the turn ends", async () => {
    mocks.events = [
      { event: "message", message: userMessage },
      { event: "message", message: reply("streaming") },
      { event: "done" },
    ];
    await send();
    expect(mocks.play.mock.calls.map(([cue]) => cue)).toEqual(["send"]);
  });

  it("plays error, and no send, when the turn fails before the message is stored", async () => {
    mocks.events = [{ event: "error", message: "Om is unavailable." }];
    expect(await send()).toBe("failed");
    expect(mocks.play.mock.calls.map(([cue]) => cue)).toEqual(["error"]);
  });

  it("plays error instead of receive when the stream breaks", async () => {
    mocks.events = [{ event: "message", message: userMessage }];
    mocks.fails = true;
    await send();
    expect(mocks.play.mock.calls.map(([cue]) => cue)).toEqual(["send", "error"]);
  });
});
