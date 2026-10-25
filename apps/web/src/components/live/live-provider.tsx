"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Realtime } from "ably";
import { useRouter } from "next/navigation";
import * as React from "react";
import { api } from "@/lib/api/client";
import { liveTokenSchema } from "@/lib/api/live";
import { setFallbackPolling } from "@/lib/api/query-client";
import {
  createLiveConnection,
  type CreateLiveClient,
  type FetchLiveToken,
  type LiveConnection,
  type LiveStatus,
} from "@/lib/live/connection";
import { orgChangesChannel, userChangesChannel } from "@/lib/live/events";
import { changesUserRecord, createLiveInvalidator } from "@/lib/live/invalidations";
import { useCurrentUser } from "../current-user";

/** The browser's live token, or `null` when realtime isn't configured. */
export const fetchLiveToken: FetchLiveToken = async () => {
  const result = await api.get("/api/ui/live/token", liveTokenSchema);
  return result.token === null ? null : result;
};

/** The real Ably client: connected by the live connection once it has a token. */
export const createAblyClient: CreateLiveClient = (options) =>
  new Realtime({ ...options, autoConnect: false, echoMessages: false, logLevel: 1 });

interface LiveContextValue {
  status: LiveStatus;
  /** Reconnects now and refetches the active queries ("Retry now"). */
  retry: () => void;
}

const LiveContext = React.createContext<LiveContextValue | null>(null);

/** Invalidates every active query of the scope's organizations (a catch-up). */
function refetchScope(client: QueryClient, scope: ReadonlySet<string>): void {
  void client.invalidateQueries({
    type: "active",
    predicate: (query) => scope.has(String(query.queryKey[0])),
  });
}

/**
 * Live data for the signed-in app (mount inside `QueryProvider`): subscribes to the change
 * channel of every organization in the current scope (the active one, or every membership
 * under "All organizations") and the user's own channel, and invalidates exactly the
 * queries each change event affects (`src/lib/live/invalidations.ts`). Channels follow the
 * scope as it changes; the connection closes on unmount.
 *
 * Queries poll (`FALLBACK_POLL_INTERVAL`) only while the connection is down or realtime is
 * off; coming back after a drop refetches the active queries once to catch up. Changes to
 * the user's own record (their theme, their memberships) re-render the shell from the
 * server in place.
 */
export function LiveProvider({
  children,
  createClient = createAblyClient,
  fetchToken = fetchLiveToken,
}: {
  children: React.ReactNode;
  /** Builds the Ably client; a fake in tests. */
  createClient?: CreateLiveClient;
  /** Fetches the live token; `GET /api/ui/live/token` by default. */
  fetchToken?: FetchLiveToken;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const user = useCurrentUser();
  const [status, setStatus] = React.useState<LiveStatus>("connecting");

  const scopeIds =
    user.scope === "all" ? user.organizations.map(({ id }) => id) : [user.organization.id];
  const scopeKey = [...new Set(scopeIds)].sort().join(",");
  const scope = React.useMemo(() => new Set(scopeKey.split(",")), [scopeKey]);
  const channels = React.useMemo(
    () => [...[...scope].map(orgChangesChannel), userChangesChannel(user.id)],
    [scope, user.id],
  );

  // The latest scope, channels and router, for the connection's callbacks.
  const latest = React.useRef({ scope, channels, router });
  React.useEffect(() => {
    latest.current = { scope, channels, router };
  });

  const connection = React.useRef<LiveConnection | null>(null);
  React.useEffect(() => {
    const invalidator = createLiveInvalidator(client);
    const userChannel = userChangesChannel(user.id);
    const live = createLiveConnection({
      userId: user.id,
      fetchToken,
      createClient,
      onStatus: setStatus,
      onEvent: (event, channel) => {
        if (channel === userChannel && changesUserRecord(event)) {
          // New memberships mean new channels: the token must grant them.
          if (event.resource === "organization") live.reauthorize();
          latest.current.router.refresh();
        }
        invalidator.apply(event, latest.current.scope);
      },
    });
    live.setChannels(latest.current.channels);
    connection.current = live;
    return () => {
      connection.current = null;
      live.close();
      invalidator.dispose();
    };
  }, [client, user.id, createClient, fetchToken]);

  React.useEffect(() => {
    connection.current?.setChannels(channels);
  }, [channels]);

  // Polling is the fallback only; a return from a drop catches up once.
  const previous = React.useRef<LiveStatus>(status);
  React.useEffect(() => {
    setFallbackPolling(client, status === "down" || status === "off");
    if (status === "live" && previous.current === "down")
      refetchScope(client, latest.current.scope);
    previous.current = status;
  }, [client, status]);

  const retry = React.useCallback(() => {
    connection.current?.reconnect();
    refetchScope(client, latest.current.scope);
  }, [client]);

  const value = React.useMemo(() => ({ status, retry }), [status, retry]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function useLive(): LiveContextValue {
  const value = React.useContext(LiveContext);
  if (!value) throw new Error("useLiveStatus must be used inside LiveProvider");
  return value;
}

/**
 * Live updates' state for screens and the shell: `live`, `connecting`, `down` (queries
 * poll; the shell shows `LiveNotice` after a while) or `off` (realtime isn't configured).
 */
export function useLiveStatus(): LiveStatus {
  return useLive().status;
}

/** Reconnects now and refetches the active queries ("Retry now"). */
export function useLiveRetry(): () => void {
  return useLive().retry;
}
