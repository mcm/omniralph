import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { formatSseEvent, type AskStreamEventName, type AskStreamEvents } from "@/lib/ask/sse";

/**
 * The open response of the web request that sent a message, as the web adapter and the
 * handler write to it while they answer: Om's reply streams to the sender as server-sent
 * events (`lib/ask/sse.ts`). Outside {@link withWebStream} (a wake-up, a card action of
 * another request) there is no open response and events are dropped.
 */

export interface WebStreamWriter {
  send<K extends AskStreamEventName>(name: K, data: AskStreamEvents[K]): void;
}

const webStreamScope = new AsyncLocalStorage<WebStreamWriter>();

/** Runs `fn` so the web adapter and handler send their events to `writer`. */
export function withWebStream<T>(writer: WebStreamWriter, fn: () => T): T {
  return webStreamScope.run(writer, fn);
}

/** Sends an event to the open web request, if any; never throws. */
export function sendWebEvent<K extends AskStreamEventName>(
  name: K,
  data: AskStreamEvents[K],
): void {
  try {
    webStreamScope.getStore()?.send(name, data);
  } catch {
    // A closed response drops what's written to it.
  }
}

/** Sent when the work behind the stream fails outside the handler (which answers its own errors). */
export const WEB_STREAM_ERROR = "Sorry, something went wrong. Please try again.";

/**
 * An event stream running `run` inside {@link withWebStream}: what `run` sends is written as
 * server-sent events, then `done` (after an `error` when `run` throws), then the stream ends.
 * The work doesn't observe the client: when it disconnects, writes are dropped and `run`
 * goes on to the end. `finished` settles when `run` is over (for the route's `after`).
 */
export function webEventStream(
  run: () => Promise<void>,
  options: { onError?: (error: unknown) => void } = {},
): { body: ReadableStream<Uint8Array>; finished: Promise<void> } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });
  const writer: WebStreamWriter = {
    send(name, data) {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(formatSseEvent(name, data)));
      } catch {
        closed = true;
      }
    },
  };
  const finished = (async () => {
    try {
      await withWebStream(writer, run);
    } catch (error) {
      options.onError?.(error);
      writer.send("error", { message: WEB_STREAM_ERROR });
    }
    writer.send("done", {});
    if (!closed) {
      closed = true;
      try {
        controller.close();
      } catch {
        // Already cancelled.
      }
    }
  })();
  return { body, finished };
}
