"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import {
  attachmentListSchema,
  featureDocumentSchema,
  featureDocumentVersionsSchema,
  featureListSchema,
  featureProgressSchema,
  featureRowSchema,
  type AttachmentList,
  type FeatureDocumentKindValue,
  type FeatureDocumentRow,
  type FeatureDocumentVersions,
  type FeatureList,
  type FeatureProgress,
  type FeatureRow,
} from "@/lib/api/features";
import { featureShardViewSchema, type FeatureShardView } from "@/lib/api/feature-shards";
import { featureProgressKeys, type QueryKeys } from "@/lib/api/keys";

/**
 * Query keys of the Features screen: the active organization's list under
 * `keys.features.lists`, and a feature at `keys.features.detail(id)` with its documents,
 * their versions and its attachments under it. A `feature` change event refetches the list
 * and the named features with everything under them.
 */
export function featuresKeys(keys: QueryKeys) {
  return {
    all: keys.features.all,
    lists: keys.features.lists,
    list: (): QueryKey => keys.features.list(),
    detail: (featureId: string): QueryKey => keys.features.detail(featureId),
    document: (featureId: string, kind: FeatureDocumentKindValue): QueryKey =>
      keys.features.part(featureId, "document", { kind }),
    versions: (featureId: string, kind: FeatureDocumentKindValue): QueryKey =>
      keys.features.part(featureId, "versions", { kind }),
    version: (featureId: string, kind: FeatureDocumentKindValue, version: number): QueryKey =>
      keys.features.part(featureId, "version", { kind, version }),
    attachments: (featureId: string): QueryKey => keys.features.part(featureId, "attachments"),
    shard: (featureId: string): QueryKey => keys.features.part(featureId, "shard"),
    progress: (featureId: string): QueryKey => featureProgressKeys(keys).feature(featureId),
  };
}

export const featurePath = (featureId: string) =>
  `/api/ui/features/${encodeURIComponent(featureId)}`;
export const documentPath = (featureId: string, kind: FeatureDocumentKindValue) =>
  `${featurePath(featureId)}/documents/${kind}`;

/** The active organization's features, newest first (`GET /api/ui/features`). A live query. */
export function useFeatureList() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<FeatureList>({
    queryKey: featuresKeys(keys).list(),
    queryFn: ({ signal }) =>
      api.get("/api/ui/features", featureListSchema, { organizationId: organization.id, signal }),
  });
}

/** One feature (`GET /api/ui/features/{id}`). A live query. */
export function useFeature(featureId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<FeatureRow>({
    queryKey: featuresKeys(keys).detail(featureId),
    queryFn: ({ signal }) =>
      api.get(featurePath(featureId), featureRowSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The latest version of a feature's PRFAQ or Plan (version 0 when never saved). A live query. */
export function useFeatureDocument(featureId: string, kind: FeatureDocumentKindValue) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<FeatureDocumentRow>({
    queryKey: featuresKeys(keys).document(featureId, kind),
    queryFn: ({ signal }) =>
      api.get(documentPath(featureId, kind), featureDocumentSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** Every saved version of a document, newest first; only while `enabled` (History open). */
export function useFeatureDocumentVersions(
  featureId: string,
  kind: FeatureDocumentKindValue,
  enabled: boolean,
) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<FeatureDocumentVersions>({
    queryKey: featuresKeys(keys).versions(featureId, kind),
    queryFn: ({ signal }) =>
      api.get(`${documentPath(featureId, kind)}/versions`, featureDocumentVersionsSchema, {
        organizationId: organization.id,
        signal,
      }),
    enabled,
  });
}

/** One saved version of a document, for History's preview; none while `version` is null. */
export function useFeatureDocumentVersion(
  featureId: string,
  kind: FeatureDocumentKindValue,
  version: number | null,
) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<FeatureDocumentRow>({
    queryKey: featuresKeys(keys).version(featureId, kind, version ?? 0),
    queryFn: ({ signal }) =>
      api.get(documentPath(featureId, kind), featureDocumentSchema, {
        params: { version: version ?? undefined },
        organizationId: organization.id,
        signal,
      }),
    enabled: version !== null,
    // A saved version never changes.
    staleTime: Infinity,
  });
}

/** A feature's attachments, oldest first (`GET /api/ui/features/{id}/attachments`). A live query. */
export function useFeatureAttachments(featureId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<AttachmentList>({
    queryKey: featuresKeys(keys).attachments(featureId),
    queryFn: ({ signal }) =>
      api.get(`${featurePath(featureId)}/attachments`, attachmentListSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * The feature's newest sharding into epics, with its rounds and drafts
 * (`GET /api/ui/features/{id}/shard`). A live query.
 */
export function useFeatureShard(featureId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<FeatureShardView>({
    queryKey: featuresKeys(keys).shard(featureId),
    queryFn: ({ signal }) =>
      api.get(`${featurePath(featureId)}/shard`, featureShardViewSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * At most how often a feature's progress refetches on live events: every run, PR and tracker
 * change of the organization refetches it (the events don't name a feature), and each fetch
 * reads the tracker.
 */
export const FEATURE_PROGRESS_LIVE_THROTTLE_MS = 5_000;

/**
 * How far along a feature is: each epic's state, stories, run and PRs, and the roll-up
 * (`GET /api/ui/features/{id}/progress`); only while `enabled`. A live query, throttled.
 */
export function useFeatureProgress(featureId: string, enabled = true) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<FeatureProgress>({
    queryKey: featuresKeys(keys).progress(featureId),
    queryFn: ({ signal }) =>
      api.get(`${featurePath(featureId)}/progress`, featureProgressSchema, {
        organizationId: organization.id,
        signal,
      }),
    enabled,
    meta: { liveThrottleMs: FEATURE_PROGRESS_LIVE_THROTTLE_MS },
  });
}
