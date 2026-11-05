"use client";

import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  savedFeatureDocumentSchema,
  savedFeatureSchema,
  uploadedAttachmentSchema,
  type AttachmentList,
  type AttachmentRow,
  type CreateFeatureBody,
  type FeatureDocumentKindValue,
  type FeatureList,
  type FeatureRow,
  type SavedFeature,
  type SavedFeatureDocument,
  type UploadedAttachment,
} from "@/lib/api/features";
import {
  featureShardViewSchema,
  type FeatureShardView,
  type FileShardBody,
  type UpdateShardDraftBody,
} from "@/lib/api/feature-shards";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import { documentPath, featurePath, featuresKeys } from "./queries";

/** Writes `feature` into its detail and every cached list (new ones first). */
async function writeFeature(cache: MutationCache, feature: FeatureRow) {
  const keys = featuresKeys(cache.keys);
  await cache.set<FeatureRow>(keys.detail(feature.id), () => feature, { exact: true });
  await cache.set<FeatureList>(keys.lists, (previous) => {
    if (!previous || !Array.isArray(previous.features)) return previous;
    const known = previous.features.some((row) => row.id === feature.id);
    return {
      ...previous,
      features: known
        ? previous.features.map((row) => (row.id === feature.id ? feature : row))
        : [feature, ...previous.features],
    };
  });
}

/** `POST /api/ui/features`: a new feature, added to the list from the answer. */
export function useCreateFeature() {
  return useApiMutation<SavedFeature, CreateFeatureBody>({
    mutationFn: (body, { organizationId }) =>
      api.post("/api/ui/features", savedFeatureSchema, { body, organizationId }),
    applyResult: (result, cache) => writeFeature(cache, result.feature),
    invalidate: (keys) => [featuresKeys(keys).lists],
    success: (result) => `Created ${result.feature.name}`,
  });
}

/** `PATCH /api/ui/features/{id}` `{archived}`: archives or restores the feature. */
export function useArchiveFeature(feature: FeatureRow) {
  return useApiMutation<SavedFeature, boolean>({
    mutationFn: (archived, { organizationId }) =>
      api.patch(`/api/ui/features/${encodeURIComponent(feature.id)}`, savedFeatureSchema, {
        body: { archived },
        organizationId,
      }),
    optimistic: (archived, cache) =>
      writeFeature(cache, { ...feature, status: archived ? "archived" : "planning" }),
    applyResult: (result, cache) => writeFeature(cache, result.feature),
    invalidate: (keys) => [featuresKeys(keys).lists, featuresKeys(keys).detail(feature.id)],
    success: (result, archived) =>
      archived ? `Archived ${result.feature.name}` : `Restored ${result.feature.name}`,
  });
}

export interface SaveDocumentVariables {
  body: string;
  /** The version the edit started from (0 for a document never saved). */
  baseVersion: number;
}

/**
 * `PUT /api/ui/features/{id}/documents/{kind}`: saves a new version. Quiet on success (it
 * autosaves); a 409 `stale_version` means someone saved a version after `baseVersion`.
 */
export function useSaveDocument(featureId: string, kind: FeatureDocumentKindValue) {
  return useApiMutation<SavedFeatureDocument, SaveDocumentVariables>({
    mutationFn: (body, { organizationId }) =>
      api.put(documentPath(featureId, kind), savedFeatureDocumentSchema, {
        body,
        organizationId,
      }),
    applyResult: (result, cache) =>
      cache.set(featuresKeys(cache.keys).document(featureId, kind), () => result.document, {
        exact: true,
      }),
    invalidate: (keys) => [featuresKeys(keys).versions(featureId, kind)],
    success: null,
  });
}

/** Writes `attachments` (added or removed) into the feature's cached list. */
function writeAttachments(
  cache: MutationCache,
  featureId: string,
  update: (attachments: readonly AttachmentRow[]) => AttachmentRow[],
) {
  return cache.set<AttachmentList>(featuresKeys(cache.keys).attachments(featureId), (previous) =>
    previous ? { ...previous, attachments: update(previous.attachments) } : previous,
  );
}

/** `POST /api/ui/features/{id}/attachments` (multipart): one file, added from the answer. */
export function useUploadAttachment(featureId: string) {
  return useApiMutation<UploadedAttachment, File>({
    mutationFn: (file, { organizationId }) => {
      const form = new FormData();
      form.set("file", file);
      return api.post(
        `/api/ui/features/${encodeURIComponent(featureId)}/attachments`,
        uploadedAttachmentSchema,
        { body: form, organizationId },
      );
    },
    applyResult: (result, cache) =>
      writeAttachments(cache, featureId, (attachments) => [
        ...attachments.filter((row) => row.id !== result.attachment.id),
        result.attachment,
      ]),
    invalidate: (keys) => [featuresKeys(keys).attachments(featureId)],
    success: (result) => `Attached ${result.attachment.fileName}`,
  });
}

/** `DELETE /api/ui/attachments/{id}`: the attachment leaves the list at once. */
export function useDeleteAttachment(featureId: string) {
  return useApiMutation<MutationResult, AttachmentRow>({
    mutationFn: (attachment, { organizationId }) =>
      api.delete(`/api/ui/attachments/${encodeURIComponent(attachment.id)}`, mutationResultSchema, {
        organizationId,
      }),
    optimistic: (attachment, cache) =>
      writeAttachments(cache, featureId, (attachments) =>
        attachments.filter((row) => row.id !== attachment.id),
      ),
    invalidate: (keys) => [featuresKeys(keys).attachments(featureId)],
    success: (_result, attachment) => `Removed ${attachment.fileName}`,
  });
}

/** Writes the answer of a sharding change into the feature's sharding. */
function writeShard(cache: MutationCache, featureId: string, view: FeatureShardView) {
  return cache.set<FeatureShardView>(featuresKeys(cache.keys).shard(featureId), () => view, {
    exact: true,
  });
}

/** `POST /api/ui/features/{id}/shard`: Om starts drafting the feature's epics from its Plan. */
export function useStartShard(featureId: string) {
  return useApiMutation<FeatureShardView, void>({
    mutationFn: (_variables, { organizationId }) =>
      api.post(`${featurePath(featureId)}/shard`, featureShardViewSchema, { organizationId }),
    applyResult: (result, cache) => writeShard(cache, featureId, result),
    invalidate: (keys) => [featuresKeys(keys).shard(featureId)],
    success: "Om is drafting the epics",
  });
}

/** `DELETE /api/ui/features/{id}/shard`: discards the drafts (or the drafting). */
export function useDiscardShard(featureId: string) {
  return useApiMutation<FeatureShardView, void>({
    mutationFn: (_variables, { organizationId }) =>
      api.delete(`${featurePath(featureId)}/shard`, featureShardViewSchema, { organizationId }),
    applyResult: (result, cache) => writeShard(cache, featureId, result),
    invalidate: (keys) => [featuresKeys(keys).shard(featureId)],
    success: "Discarded the drafts",
  });
}

export type UpdateShardDraftVariables = UpdateShardDraftBody & { key: string };

/** `PATCH /api/ui/features/{id}/shard/drafts/{key}`: edits, removes or approves one draft. */
export function useUpdateShardDraft(featureId: string) {
  return useApiMutation<FeatureShardView, UpdateShardDraftVariables>({
    mutationFn: ({ key, ...body }, { organizationId }) =>
      api.patch(
        `${featurePath(featureId)}/shard/drafts/${encodeURIComponent(key)}`,
        featureShardViewSchema,
        { body, organizationId },
      ),
    optimistic: ({ key, ...body }, cache) =>
      cache.set<FeatureShardView>(featuresKeys(cache.keys).shard(featureId), (previous) =>
        previous?.shard
          ? {
              ...previous,
              shard: {
                ...previous.shard,
                drafts: previous.shard.drafts.map((draft) =>
                  draft.key === key ? { ...draft, ...body } : draft,
                ),
              },
            }
          : previous,
      ),
    applyResult: (result, cache) => writeShard(cache, featureId, result),
    invalidate: (keys) => [featuresKeys(keys).shard(featureId)],
    success: null,
  });
}

/** `POST /api/ui/features/{id}/shard/file`: files the approved drafts as epics. */
export function useFileShard(featureId: string) {
  return useApiMutation<FeatureShardView, FileShardBody>({
    mutationFn: (body, { organizationId }) =>
      api.post(`${featurePath(featureId)}/shard/file`, featureShardViewSchema, {
        body,
        organizationId,
      }),
    applyResult: (result, cache) => writeShard(cache, featureId, result),
    invalidate: (keys) => [
      featuresKeys(keys).shard(featureId),
      featuresKeys(keys).detail(featureId),
      featuresKeys(keys).lists,
    ],
    success: (result) => {
      const filed = result.shard?.drafts.filter((draft) => draft.filed).length ?? 0;
      return filed === 1
        ? "Filed 1 epic. Om is triaging it into tasks."
        : `Filed ${filed} epics. Om is triaging them into tasks.`;
    },
  });
}
