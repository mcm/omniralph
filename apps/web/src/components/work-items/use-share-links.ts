"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { z } from "zod";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation } from "@/components/use-api-mutation";
import type { QueryKeys } from "@/lib/api/keys";
import { api } from "@/lib/api/client";
import {
  createShareLinkResultSchema,
  shareLinkListSchema,
  type CreateShareLinkResponse,
  type ShareLink,
} from "@/lib/api/work-items";
import { workItemDetailPath } from "./use-work-item-detail";

/** The work item a review link belongs to: its URL ID and its organization. */
export interface ShareLinkTarget {
  id: string;
  organization: { id: string };
}

type ShareLinkList = z.infer<typeof shareLinkListSchema>;

/**
 * The item's share links, under its detail key (`[…, "detail", id, "share-links", {}]`), so a
 * `work_item` change event naming the item refetches them.
 */
export const shareLinksKey = (keys: QueryKeys, workItemId: string): QueryKey =>
  keys.workItems.part(workItemId, "share-links");

const shareLinksPath = (workItemId: string) => `${workItemDetailPath(workItemId)}/share-links`;

/** The item's active review links (`GET /api/ui/work-items/{id}/share-links`), a live query. */
export function useShareLinks(target: ShareLinkTarget) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<ShareLinkList>({
    queryKey: shareLinksKey(keys, target.id),
    queryFn: ({ signal }) =>
      api.get(shareLinksPath(target.id), shareLinkListSchema, {
        params: { organization: target.organization.id },
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * Create link (`POST /api/ui/work-items/{id}/share-links`, an empty password for none): the
 * new link joins the cached list from the response (its URL is only in the response).
 */
export function useCreateShareLink(target: ShareLinkTarget) {
  return useApiMutation<CreateShareLinkResponse, { password: string }>({
    mutationFn: (body, { organizationId }) =>
      api.post(shareLinksPath(target.id), createShareLinkResultSchema, {
        body,
        params: { organization: target.organization.id },
        organizationId,
      }),
    applyResult: async ({ link }, cache) => {
      await cache.set<ShareLinkList>(
        shareLinksKey(cache.keys, target.id),
        (previous) =>
          previous && {
            links: [...previous.links.filter((entry) => entry.id !== link.id), link],
          },
        { exact: true },
      );
    },
    invalidate: (keys) => [shareLinksKey(keys, target.id)],
    success: "Review link created",
  });
}

/**
 * Revoke (`DELETE /api/ui/share-links/{linkId}`): the link leaves the list at once, and comes
 * back with the server's message if revoking fails.
 */
export function useRevokeShareLink(target: ShareLinkTarget) {
  return useApiMutation<{ ok: true }, ShareLink>({
    mutationFn: (link, { organizationId }) =>
      api.delete(
        `/api/ui/share-links/${encodeURIComponent(link.id)}`,
        z.object({ ok: z.literal(true) }),
        { organizationId },
      ),
    optimistic: async (link, cache) => {
      await cache.set<ShareLinkList>(
        shareLinksKey(cache.keys, target.id),
        (previous) => previous && { links: previous.links.filter((entry) => entry.id !== link.id) },
        { exact: true },
      );
    },
    invalidate: (keys) => [shareLinksKey(keys, target.id)],
    success: "Review link revoked",
  });
}
