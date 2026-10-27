/**
 * The server-sent events of an Ask turn, on the request that sent the message
 * (`POST /api/ui/ask/chats`, `POST /api/ui/ask/chats/{id}/messages`): each event is
 * `event: <name>` plus one JSON `data:` line, then a blank line. Shared by the server
 * ({@link formatSseEvent}) and the client, which reads the response body with a
 * `ReadableStream` reader ({@link parseSseChunks}; `EventSource` can't POST).
 */

/** What each event of an Ask turn carries. */
export interface AskStreamEvents {
  /** First event of a new chat. */
  chat: { chat: unknown };
  /** A stored message in full (the user's, a card, Om's final text, an edited card). */
  message: { message: unknown };
  /** Text appended to a streaming Om message. */
  delta: { messageId: string; text: string };
  /** What Om is doing, as a plain sentence. */
  status: { text: string };
  error: { message: string };
  /** The turn is over. */
  done: Record<string, never>;
}

export type AskStreamEventName = keyof AskStreamEvents;

export const ASK_STREAM_EVENT_NAMES: readonly AskStreamEventName[] = [
  "chat",
  "message",
  "delta",
  "status",
  "error",
  "done",
];

export type AskStreamEvent = {
  [K in AskStreamEventName]: { event: K; data: AskStreamEvents[K] };
}[AskStreamEventName];

/** One event as it goes on the wire. */
export function formatSseEvent<K extends AskStreamEventName>(
  name: K,
  data: AskStreamEvents[K],
): string {
  // JSON.stringify never emits a raw newline, so the payload is one `data:` line.
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

const isEventName = (name: string): name is AskStreamEventName =>
  (ASK_STREAM_EVENT_NAMES as readonly string[]).includes(name);

/** One complete event block (without its blank line), or null for a comment or unknown event. */
function parseBlock(block: string): AskStreamEvent | null {
  let name = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 || !isEventName(name)) return null;
  try {
    return { event: name, data: JSON.parse(data.join("\n")) } as AskStreamEvent;
  } catch {
    return null;
  }
}

/**
 * The complete events in `buffer` (what was received so far, decoded), and the rest: an
 * event cut between two chunks stays in `rest` until the next chunk completes it.
 */
export function parseSseChunks(buffer: string): { events: AskStreamEvent[]; rest: string } {
  const events: AskStreamEvent[] = [];
  const separator = /\r?\n\r?\n/g;
  let start = 0;
  for (let match = separator.exec(buffer); match; match = separator.exec(buffer)) {
    const event = parseBlock(buffer.slice(start, match.index));
    if (event) events.push(event);
    start = match.index + match[0].length;
  }
  return { events, rest: buffer.slice(start) };
}
