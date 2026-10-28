/**
 * Keeps the page current: an `EventSource` on `/api/events` applies each change to the cache
 * (`./invalidations.ts`). While the stream is down, queries poll every 10 s; when it comes
 * back after a drop, every query refetches once to catch up. `LiveNoticeSlot` shows the one
 * connection status there is, after 5 s down.
 */
import { LiveNotice } from "@omniralph/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useUnauthorized } from "../api.js";
import { setFallbackPolling } from "../query-client.js";
import { applyLiveChange, parseLiveChange } from "./invalidations.js";

export const LIVE_EVENTS_PATH = "/api/events";
/** How long the stream must have been down before the page says so. */
export const LIVE_NOTICE_DELAY_MS = 5_000;
/** After the browser gives up on a stream (it answered an error), it's opened again this soon. */
export const LIVE_RECONNECT_MS = 5_000;

/** `connecting` until the stream first opens, `live` while it's open, `down` otherwise. */
export type LiveStatus = "connecting" | "live" | "down";

/** The part of `EventSource` the page uses (faked in tests). */
export interface LiveEventSource {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void;
  close(): void;
}

export type CreateEventSource = (url: string) => LiveEventSource;

const EVENT_SOURCE_CLOSED = 2;

const defaultCreateEventSource: CreateEventSource = (url) => new EventSource(url);

interface LiveContextValue {
  status: LiveStatus;
  retry: () => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export interface LiveProviderProps {
  createEventSource?: CreateEventSource;
  children?: ReactNode;
}

export function LiveProvider({
  createEventSource = defaultCreateEventSource,
  children,
}: LiveProviderProps) {
  const client = useQueryClient();
  const unauthorized = useUnauthorized();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  // Bumped by "Retry now" to open a new stream at once.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    // A 401 replaces the page: nothing to keep current.
    if (unauthorized) return;
    let source: LiveEventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const open = () => {
      reconnect = null;
      const current = createEventSource(LIVE_EVENTS_PATH);
      source = current;
      current.addEventListener("open", () => {
        if (!disposed && source === current) setStatus("live");
      });
      current.addEventListener("change", (event) => {
        if (disposed || source !== current) return;
        const change = parseLiveChange((event as MessageEvent).data);
        if (change) applyLiveChange(client, change);
      });
      current.addEventListener("error", () => {
        if (disposed || source !== current) return;
        setStatus("down");
        // The browser retries a dropped stream itself, but not one that answered an error.
        if (current.readyState === EVENT_SOURCE_CLOSED && reconnect === null) {
          current.close();
          reconnect = setTimeout(open, LIVE_RECONNECT_MS);
        }
      });
    };
    open();
    return () => {
      disposed = true;
      if (reconnect !== null) clearTimeout(reconnect);
      source?.close();
    };
  }, [client, createEventSource, unauthorized, generation]);

  // Polling is the fallback only; a return from a drop catches up once.
  const previous = useRef<LiveStatus>(status);
  useEffect(() => {
    setFallbackPolling(client, status === "down");
    if (status === "live" && previous.current === "down") void client.invalidateQueries();
    previous.current = status;
  }, [client, status]);

  const retry = useCallback(() => {
    setGeneration((value) => value + 1);
    void client.invalidateQueries();
  }, [client]);

  const value = useMemo(() => ({ status, retry }), [status, retry]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function useLive(): LiveContextValue {
  const value = useContext(LiveContext);
  if (!value) throw new Error("useLiveStatus must be used inside LiveProvider.");
  return value;
}

export function useLiveStatus(): LiveStatus {
  return useLive().status;
}

/** `LiveNotice` once the stream has been down for `LIVE_NOTICE_DELAY_MS`; otherwise nothing. */
export function LiveNoticeSlot() {
  const { status, retry } = useLive();
  const down = status === "down";
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) return;
    const timer = setTimeout(() => setShown(true), LIVE_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [down]);
  return down && shown ? <LiveNotice onRetry={retry} className="agent-page__notice" /> : null;
}
