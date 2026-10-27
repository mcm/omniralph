import { ApiError, NETWORK_ERROR, UNEXPECTED_RESPONSE } from "@/lib/api/client";
import { askChatSchema, askMessageSchema, type AskChat, type AskMessageView } from "@/lib/api/ask";
import { apiErrorBodySchema, ORGANIZATION_HEADER } from "@/lib/api/schemas";
import { parseSseChunks, type AskStreamEvent } from "./sse";

/**
 * An Ask turn's event as the client applies it: `chat` and `message` parsed with their
 * API schemas (an event that doesn't match is dropped).
 */
export type AskTurnEvent =
  | { event: "chat"; chat: AskChat }
  | { event: "message"; message: AskMessageView }
  | { event: "delta"; messageId: string; text: string }
  | { event: "status"; text: string }
  | { event: "error"; message: string }
  | { event: "done" };

function turnEvent(event: AskStreamEvent): AskTurnEvent | null {
  switch (event.event) {
    case "chat": {
      const parsed = askChatSchema.safeParse(event.data.chat);
      return parsed.success ? { event: "chat", chat: parsed.data } : null;
    }
    case "message": {
      const parsed = askMessageSchema.safeParse(event.data.message);
      return parsed.success ? { event: "message", message: parsed.data } : null;
    }
    case "delta":
      return typeof event.data.messageId === "string" && typeof event.data.text === "string"
        ? { event: "delta", messageId: event.data.messageId, text: event.data.text }
        : null;
    case "status":
      return typeof event.data.text === "string"
        ? { event: "status", text: event.data.text }
        : null;
    case "error":
      return { event: "error", message: String(event.data.message ?? UNEXPECTED_RESPONSE) };
    case "done":
      return { event: "done" };
  }
}

export interface AskTurnRequest {
  /** `/api/ui/ask/chats` (a new chat) or `/api/ui/ask/chats/{id}/messages`. */
  path: string;
  body: unknown;
  /** The organization the caller's cache is for (the handler refuses a switched tab). */
  organizationId: string;
  /** Each event, in order, as it arrives. */
  onEvent: (event: AskTurnEvent) => void;
}

/**
 * Sends an Ask turn and reads its `text/event-stream` answer with a `ReadableStream`
 * reader (`EventSource` can't POST), calling `onEvent` per event as it arrives. Resolves
 * when the stream ends. Throws `ApiError` when the request is refused (with the server's
 * message) or never reaches the server; a stream cut short ends without `done`.
 */
export async function streamAskTurn({
  path,
  body,
  organizationId,
  onEvent,
}: AskTurnRequest): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        [ORGANIZATION_HEADER]: organizationId,
      },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(NETWORK_ERROR, 0);
  }
  if (!response.ok) {
    const json: unknown = await response.json().catch(() => null);
    const parsed = apiErrorBodySchema.safeParse(json);
    if (!parsed.success) throw new ApiError(UNEXPECTED_RESPONSE, response.status);
    const { error, code, fieldErrors, enterPath } = parsed.data;
    throw new ApiError(error, response.status, code, fieldErrors, enterPath);
  }
  if (!response.body) throw new ApiError(UNEXPECTED_RESPONSE, response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (chunk: string) => {
    const { events, rest } = parseSseChunks(buffer + chunk);
    buffer = rest;
    for (const event of events) {
      const parsed = turnEvent(event);
      if (parsed) onEvent(parsed);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      emit(decoder.decode(value, { stream: true }));
    }
  } catch {
    throw new ApiError(NETWORK_ERROR, 0);
  }
  emit(decoder.decode() + "\n\n");
}
