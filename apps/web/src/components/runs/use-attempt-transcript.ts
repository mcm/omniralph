"use client";

import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { transcriptPageSchema, type TranscriptPageView } from "@/lib/api/runs";

type TranscriptEventView = TranscriptPageView["events"][number];

/** An attempt's transcript as far as it is loaded, oldest first. */
export interface AttemptTranscript {
  events: TranscriptEventView[];
  /** The last page loaded: where it starts in `events`, and the cursor it was asked with. */
  tail: { index: number; cursor: string | null };
  /** The page after the loaded ones; null when everything is loaded. */
  nextCursor: string | null;
  /** Loaded after the attempt finished: it won't change again. */
  final: boolean;
}

/** The transcript query of one attempt, under its run's transcripts (`transcript` events). */
export function attemptTranscriptKey(
  keys: ReturnType<typeof useQueryKeys>,
  runId: string,
  attemptId: string,
): QueryKey {
  return keys.transcripts.part(runId, "attempt", { attempt: attemptId });
}

/**
 * An attempt's transcript (`GET /api/ui/runs/{id}/attempts/{attemptId}/transcript`), the
 * first page at first; `loadMore` loads the next page through the cursor. While the attempt
 * is `live` (queued or running), its run's `transcript` change events refetch the last
 * loaded page only and append what is new; once it has finished, one last refetch settles
 * it and later events leave it alone. It sets no `refetchInterval`: it polls only while live
 * updates are down.
 */
export function useAttemptTranscript(runId: string, attemptId: string, live: boolean) {
  const keys = useQueryKeys();
  const client = useQueryClient();
  const { organization } = useCurrentUser();
  const queryKey = attemptTranscriptKey(keys, runId, attemptId);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const loading = useRef(false);

  const fetchPage = useCallback(
    (cursor: string | null, signal?: AbortSignal) =>
      api.get(
        `/api/ui/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/transcript`,
        transcriptPageSchema,
        { params: { cursor }, organizationId: organization.id, signal },
      ),
    [runId, attemptId, organization.id],
  );

  const query = useQuery<AttemptTranscript>({
    queryKey,
    queryFn: async ({ signal }) => {
      const previous = client.getQueryData<AttemptTranscript>(queryKey);
      if (previous?.final) return previous;
      const tail = previous?.tail ?? { index: 0, cursor: null };
      const page = await fetchPage(tail.cursor, signal);
      const current = client.getQueryData<AttemptTranscript>(queryKey);
      // A page loaded meanwhile (`loadMore`): keep it, the next event refetches.
      if (current !== previous && current) return current;
      return {
        events: [...(previous?.events.slice(0, tail.index) ?? []), ...page.events],
        tail,
        nextCursor: page.nextCursor,
        final: !live,
      };
    },
  });

  // The attempt just finished: settle the transcript with its last events.
  const { data, refetch } = query;
  const unsettled = !live && data !== undefined && !data.final;
  useEffect(() => {
    if (unsettled) void refetch();
  }, [unsettled, refetch]);

  const loadMore = useCallback(async () => {
    const before = client.getQueryData<AttemptTranscript>(queryKey);
    const cursor = before?.nextCursor;
    if (!before || !cursor || loading.current) return;
    loading.current = true;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const page = await fetchPage(cursor);
      client.setQueryData<AttemptTranscript>(queryKey, (current) =>
        current && current.nextCursor === cursor
          ? {
              events: [...current.events, ...page.events],
              tail: { index: current.events.length, cursor },
              nextCursor: page.nextCursor,
              final: current.final,
            }
          : current,
      );
    } catch {
      setLoadMoreFailed(true);
    } finally {
      loading.current = false;
      setLoadingMore(false);
    }
  }, [client, fetchPage, queryKey]);

  return { ...query, loadMore, loadingMore, loadMoreFailed };
}
