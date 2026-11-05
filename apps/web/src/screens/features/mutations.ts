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
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import { documentPath, featuresKeys } from "./queries";

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
