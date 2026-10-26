"use client";

import { MAX_PATH_EXCLUDES, pathExcludeGlobError, type ReviewDepth } from "@omniralph/shared";
import {
  Card,
  Checkbox,
  DetailsPopover,
  Field,
  SaveBar,
  SegmentedControl,
  Switch,
  Textarea,
  TokenInput,
} from "@omniralph/ui";
import { useCallback, useId, useMemo } from "react";
import type { z } from "zod";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { useStagedCard, type StagedChange } from "@/components/use-staged-card";
import { api } from "@/lib/api/client";
import {
  cardSaveResultSchema,
  reviewsCardSchema,
  type RepositoryDetail,
  type ReviewsCard as ReviewsCardData,
  type ReviewsCardInput,
} from "@/lib/api/repositories";
import {
  requestAbbreviation,
  requestNoun,
  reviewDepthEffect,
  reviewDraftsEffect,
  reviewerInstructionsEffect,
  reviewOnOpenEffect,
  reviewOnPushEffect,
  reviewsEnabledEffect,
  skipPathEffects,
  type CodeHost,
} from "@/lib/repositories/effects";
import { applySavedCard } from "./mutations";

const reviewsSaveResultSchema = cardSaveResultSchema(reviewsCardSchema);

/** The Reviews card's fields, one key each, as `useStagedCard` stages them. */
export interface ReviewsDraft {
  enabled: boolean;
  onOpen: boolean;
  onPush: boolean;
  drafts: boolean;
  depth: ReviewDepth;
  pathExcludes: string[];
  reviewerInstructions: string;
}

function toDraft(card: ReviewsCardData): ReviewsDraft {
  return {
    enabled: card.enabled,
    onOpen: card.triggers.onOpen,
    onPush: card.triggers.onPush,
    drafts: card.triggers.drafts,
    depth: card.depth,
    pathExcludes: card.pathExcludes,
    reviewerInstructions: card.reviewerInstructions,
  };
}

/** `PUT /api/ui/repositories/{id}/reviews`'s body: the whole card. */
export function reviewsInput(draft: ReviewsDraft): ReviewsCardInput {
  return {
    reviewsEnabled: draft.enabled,
    triggers: { onOpen: draft.onOpen, onPush: draft.onPush, drafts: draft.drafts },
    depth: draft.depth,
    pathExcludes: draft.pathExcludes,
    reviewerInstructions: draft.reviewerInstructions,
  };
}

/** The save bar's items: each field that differs, in the card's order, with its effect. */
export function reviewsChanges(
  provider: CodeHost,
  saved: ReviewsDraft,
  draft: ReviewsDraft,
): StagedChange[] {
  const changes: StagedChange[] = [];
  if (draft.enabled !== saved.enabled) changes.push(reviewsEnabledEffect(provider, draft.enabled));
  if (draft.onOpen !== saved.onOpen) changes.push(reviewOnOpenEffect(provider, draft.onOpen));
  if (draft.onPush !== saved.onPush) changes.push(reviewOnPushEffect(provider, draft.onPush));
  if (draft.drafts !== saved.drafts) changes.push(reviewDraftsEffect(provider, draft.drafts));
  if (draft.depth !== saved.depth) changes.push(reviewDepthEffect(saved.depth, draft.depth));
  changes.push(...skipPathEffects(saved.pathExcludes, draft.pathExcludes));
  if (draft.reviewerInstructions !== saved.reviewerInstructions) {
    changes.push(reviewerInstructionsEffect());
  }
  return changes;
}

/** "Save 1 change" / "Save 3 changes". */
export function saveChangesLabel(count: number): string {
  return count === 1 ? "Save 1 change" : `Save ${count} changes`;
}

/** The first field error under `prefix` (`pathExcludes` covers `pathExcludes.3`). */
function errorAt(errors: Readonly<Record<string, string>>, prefix: string): string | undefined {
  return Object.entries(errors).find(
    ([path]) => path === prefix || path.startsWith(`${prefix}.`),
  )?.[1];
}

/** Field labels the card and its save bar share; PR or MR follows the provider. */
function openedLabel(provider: CodeHost): string {
  return `${requestAbbreviation(provider)} opened`;
}

/**
 * The Reviews card (Design rule 12): its switch, when reviews start, the depth with its
 * summary and "<Depth> review profile", skip paths and reviewer instructions, staged in its
 * save bar with each change's effect and saved in one request
 * (`PUT /api/ui/repositories/{id}/reviews`). Members see it read-only.
 */
export function ReviewsCard({ detail, titleId }: { detail: RepositoryDetail; titleId: string }) {
  const { repository, canEdit } = detail;
  const provider = repository.provider;
  const ids = useId();
  const saved = useMemo(() => toDraft(detail.reviews), [detail.reviews]);
  const toChanges = useCallback(
    (from: ReviewsDraft, to: ReviewsDraft) => reviewsChanges(provider, from, to),
    [provider],
  );
  const card = useStagedCard<ReviewsDraft, z.infer<typeof reviewsSaveResultSchema>>({
    label: "Reviews",
    anchorId: "reviews",
    saved,
    toChanges,
    save: {
      request: (draft, { organizationId }) =>
        api.put(
          `/api/ui/repositories/${encodeURIComponent(repository.id)}/reviews`,
          reviewsSaveResultSchema,
          { body: reviewsInput(draft), organizationId },
        ),
      applyResult: (result, cache) =>
        applySavedCard(
          cache,
          repository.id,
          (previous) => ({ ...previous, reviews: result.card }),
          (row) => ({ ...row, reviewsEnabled: result.card.enabled }),
        ),
    },
  });
  const { draft, set, fieldErrors } = card;
  const disabled = !canEdit || card.saving;
  const depth = detail.depths.find((option) => option.id === draft.depth);
  const reviewWhenId = `${ids}-review-when`;
  const depthLabelId = `${ids}-depth`;
  const skipPathsError = errorAt(fieldErrors, "pathExcludes");
  const skipPathsErrorId = `${ids}-skip-paths-error`;

  return (
    <Card
      title="Reviews"
      titleId={titleId}
      className="or-repo-card"
      titleAddon={
        <ChangeHistoryPopover
          section="repository.reviews"
          subject={repository.id}
          organization={repository.organization.id}
          latest={detail.history.reviews}
        />
      }
      actions={
        <Switch
          aria-label="Reviews"
          checked={draft.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => set("enabled", checked)}
        />
      }
    >
      <p className="or-repo-card__help">
        Om reviews {requestNoun(provider)}s and comments on them.
      </p>
      {errorAt(fieldErrors, "reviewsEnabled") ? (
        <p className="or-field-error">{errorAt(fieldErrors, "reviewsEnabled")}</p>
      ) : null}
      <div className="or-repo-card__fields">
        <div className="or-field">
          <div className="or-field__head">
            <span id={reviewWhenId} className="or-field__label">
              Review when
            </span>
          </div>
          <div className="or-field__control">
            <div role="group" aria-labelledby={reviewWhenId} className="or-repo-checks">
              <Checkbox
                label={openedLabel(provider)}
                checked={draft.onOpen}
                disabled={disabled}
                onCheckedChange={(checked) => set("onOpen", checked)}
              />
              <Checkbox
                label="New commits pushed"
                checked={draft.onPush}
                disabled={disabled}
                onCheckedChange={(checked) => set("onPush", checked)}
              />
              <Checkbox
                label="Drafts too"
                checked={draft.drafts}
                disabled={disabled}
                onCheckedChange={(checked) => set("drafts", checked)}
              />
            </div>
            {errorAt(fieldErrors, "triggers") ? (
              <p className="or-field-error">{errorAt(fieldErrors, "triggers")}</p>
            ) : null}
          </div>
        </div>
        <div className="or-field">
          <div className="or-field__head">
            <span id={depthLabelId} className="or-field__label">
              Depth
            </span>
          </div>
          <div className="or-field__control">
            <SegmentedControl<ReviewDepth>
              aria-labelledby={depthLabelId}
              options={detail.depths.map((option) => ({
                value: option.id,
                label: option.label,
                disabled,
              }))}
              value={draft.depth}
              onValueChange={(value) => set("depth", value)}
            />
            {depth ? (
              <div className="or-repo-depth">
                <p className="or-repo-depth__summary">{depth.summary}</p>
                <DetailsPopover
                  label={`${depth.label} review profile`}
                  items={[
                    { term: "Model", detail: depth.details.model },
                    { term: "Token cap", detail: depth.details.tokenCap },
                    { term: "Reads", detail: depth.details.reads },
                    { term: "Comments", detail: depth.details.comments },
                    { term: "Typical time", detail: depth.details.typicalTime },
                  ]}
                />
              </div>
            ) : null}
            {errorAt(fieldErrors, "depth") ? (
              <p className="or-field-error">{errorAt(fieldErrors, "depth")}</p>
            ) : null}
          </div>
        </div>
        <Field label="Skip paths" description="Reviews leave out files that match.">
          <TokenInput
            values={draft.pathExcludes}
            onChange={(values) => set("pathExcludes", values)}
            placeholder="Add a path or glob…"
            disabled={disabled}
            validate={(value) =>
              draft.pathExcludes.length >= MAX_PATH_EXCLUDES
                ? `At most ${MAX_PATH_EXCLUDES} patterns.`
                : pathExcludeGlobError(value)
            }
            aria-describedby={skipPathsError ? skipPathsErrorId : undefined}
          />
          {skipPathsError ? (
            <p id={skipPathsErrorId} className="or-field-error">
              {skipPathsError}
            </p>
          ) : null}
        </Field>
        <Field
          label="Reviewer instructions"
          description="Om follows these in every review of this repo."
        >
          <Textarea
            value={draft.reviewerInstructions}
            disabled={disabled}
            onChange={(event) => set("reviewerInstructions", event.target.value)}
            errorMessage={errorAt(fieldErrors, "reviewerInstructions")}
          />
        </Field>
      </div>
      {canEdit ? (
        <SaveBar
          changes={card.changes}
          onSave={card.submit}
          onDiscard={card.discard}
          saving={card.saving}
          error={card.error}
          saveLabel={saveChangesLabel(card.changes.length)}
        />
      ) : null}
      {card.dialog}
    </Card>
  );
}
