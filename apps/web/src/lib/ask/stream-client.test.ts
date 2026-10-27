import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, NETWORK_ERROR } from "@/lib/api/client";
import { ORGANIZATION_HEADER } from "@/lib/api/schemas";
import { formatSseEvent } from "./sse";
import { streamAskTurn, type AskTurnEvent } from "./stream-client";

const ORG = "11111111-1111-4111-8111-111111111111";

const message = {
  id: "m-1",
  author: "om",
  markdown: "Hi",
  status: "complete",
  createdAt: "2026-10-27T10:00:00.000Z",
  run: null,
  files: [],
  workItems: [],
  card: null,
};

/** A response whose body arrives as `chunks`. */
function chunked(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamAskTurn", () => {
  it("posts the body and reports each event in order, across chunk boundaries", async () => {
    const wire =
      formatSseEvent("message", { message }) +
      formatSseEvent("delta", { messageId: "m-1", text: "Hello" }) +
      formatSseEvent("status", { text: "Looking at runs" }) +
      formatSseEvent("message", { message: { id: "broken" } }) +
      formatSseEvent("error", { message: "Om couldn't answer." }) +
      formatSseEvent("done", {});
    const fetch = vi.fn(async () =>
      chunked([wire.slice(0, 17), wire.slice(17, 90), wire.slice(90)]),
    );
    vi.stubGlobal("fetch", fetch);
    const events: AskTurnEvent[] = [];

    await streamAskTurn({
      path: "/api/ui/ask/chats/c/messages",
      body: { text: "Hi" },
      organizationId: ORG,
      onEvent: (event) => events.push(event),
    });

    expect(events).toEqual([
      { event: "message", message },
      { event: "delta", messageId: "m-1", text: "Hello" },
      { event: "status", text: "Looking at runs" },
      { event: "error", message: "Om couldn't answer." },
      { event: "done" },
    ]);
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/ui/ask/chats/c/messages");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ text: "Hi" }));
    expect((init.headers as Record<string, string>)[ORGANIZATION_HEADER]).toBe(ORG);
  });

  it("throws the server's message when the turn is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Write a message." }, { status: 400 })),
    );
    const error = await streamAskTurn({
      path: "/x",
      body: {},
      organizationId: ORG,
      onEvent: () => {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("Write a message.");
    expect((error as ApiError).status).toBe(400);
  });

  it("throws a network error when the server can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(
      streamAskTurn({ path: "/x", body: {}, organizationId: ORG, onEvent: () => {} }),
    ).rejects.toThrow(NETWORK_ERROR);
  });
});
