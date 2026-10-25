"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import { reviewProfilesSchema } from "@/lib/api/review-profiles";
import { reviewProfilesKey } from "@/lib/api/settings-keys";

export { reviewProfilesKey };

/** The organization's review profiles and model choices, live (`GET /api/ui/review-profiles`, admins). */
export function useReviewProfiles() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: reviewProfilesKey(keys),
    queryFn: ({ signal }) =>
      api.get("/api/ui/review-profiles", reviewProfilesSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * What a profile change affects: this page and every repository query (a repository's
 * Settings tab shows its profile's limits).
 */
export const reviewProfileChanged = (keys: QueryKeys) => [
  reviewProfilesKey(keys),
  keys.repositories.all,
];
