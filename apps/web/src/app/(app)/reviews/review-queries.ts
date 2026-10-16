"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { reviewDetailSchema, reviewListSchema } from "@/lib/api/reviews";
import type { ReviewListParams } from "@/lib/reviews/display";

/** The page asking, so a resource of another organization switches to it and comes back here. */
function currentPage(): string | undefined {
  return typeof window === "undefined"
    ? undefined
    : `${window.location.pathname}${window.location.search}`;
}

/**
 * A page of the organization's reviews for the list's filters, live; with `repositoryId`,
 * that repository's (Repository › Reviews).
 */
export function useReviewList(params: ReviewListParams, repositoryId: string | null) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.reviews.list({ ...params, repositoryId }),
    queryFn: ({ signal }) =>
      api.get("/api/ui/reviews", reviewListSchema, {
        params: {
          status: params.status ?? undefined,
          trigger: params.trigger ?? undefined,
          page: params.page > 1 ? params.page : undefined,
          repository: repositoryId ?? undefined,
          next: repositoryId ? currentPage() : undefined,
        },
        organizationId: organization.id,
        signal,
      }),
    // The previous results stay (dimmed) while the new filter or page loads; not another
    // repository's, whose header would show.
    placeholderData: (previous) =>
      (previous?.repository?.id ?? null) === repositoryId ? keepPreviousData(previous) : undefined,
  });
}

/** A review with its findings, live (`GET /api/ui/reviews/{id}`). */
export function useReviewDetail(reviewId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.reviews.detail(reviewId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/reviews/${reviewId}`, reviewDetailSchema, {
        params: { next: currentPage() },
        organizationId: organization.id,
        signal,
      }),
  });
}
