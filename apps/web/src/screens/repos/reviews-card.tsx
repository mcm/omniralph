"use client";

import {
  DOCUMENTATION_CHECK_MODES,
  DOCUMENTATION_UPDATE_TARGETS,
  MAX_PATH_EXCLUDES,
  pathExcludeGlobError,
  type DocumentationCheckMode,
  type DocumentationDepth,
  type DocumentationUpdateTargets,
  type ReviewDepth,
} from "@omniralph/shared";
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
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { useCallback, useId, useMemo } from "react";
import type { z } from "zod";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { api } from "@/lib/api/client";
import {
  cardSaveResultSchema,
  reviewsCardSchema,
  type RepositoryDetail,
  type ReviewsCard as ReviewsCardData,
  type ReviewsCardInput,
} from "@/lib/api/repositories";
import {
  DOCUMENTATION_CHECK_LABELS,
  documentationCheckEffect,
  documentationDepthEffect,
  documentationUpdateTargetsEffect,
  documentationUpdateTargetsLabel,
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
  documentationCheck: DocumentationCheckMode;
  documentationDepth: DocumentationDepth;
  documentationUpdateTargets: DocumentationUpdateTargets;
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
    documentationCheck: card.documentation.check,
    documentationDepth: card.documentation.depth,
    documentationUpdateTargets: card.documentation.updateTargets,
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
    documentation: {
      check: draft.documentationCheck,
      depth: draft.documentationDepth,
      updateTargets: draft.documentationUpdateTargets,
    },
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
  if (draft.documentationCheck !== saved.documentationCheck) {
    changes.push(
      documentationCheckEffect(provider, saved.documentationCheck, draft.documentationCheck),
    );
  }
  if (draft.documentationDepth !== saved.documentationDepth) {
    changes.push(documentationDepthEffect(saved.documentationDepth, draft.documentationDepth));
  }
  if (draft.documentationUpdateTargets !== saved.documentationUpdateTargets) {
    changes.push(
      documentationUpdateTargetsEffect(
        provider,
        saved.documentationUpdateTargets,
        draft.documentationUpdateTargets,
      ),
    );
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

/** The documentation check's mode, in one line (PR or MR by provider). */
export function documentationCheckHelp(provider: CodeHost, mode: DocumentationCheckMode): string {
  const request = requestNoun(provider);
  switch (mode) {
    case "off":
      return "Om doesn't check documentation.";
    case "comment":
      return `Om comments on each ${request} with the documentation the change makes wrong or incomplete.`;
    case "update":
      return `Om commits the documentation updates to the ${request}s chosen below and comments on the rest.`;
  }
}

/** Which PRs (MRs) an Update check commits to, in one line. */
export function documentationUpdateTargetsHelp(
  provider: CodeHost,
  targets: DocumentationUpdateTargets,
): string {
  const requests = `${requestNoun(provider)}s`;
  return targets === "omniralph"
    ? `Only ${requests} Om opened. People's ${requests} get the comment.`
    : `Also people's ${requests} whose branch is in this repo. Forks get the comment.`;
}

/**
 * The Reviews card's Documentation section: the mode, the depth with its summary and
 * "<Depth> documentation check" details, and in Update mode which PRs it commits to.
 */
function DocumentationSection({
  provider,
  draft,
  set,
  depths,
  disabled,
  fieldErrors,
}: {
  provider: CodeHost;
  draft: ReviewsDraft;
  set: <K extends keyof ReviewsDraft>(key: K, value: ReviewsDraft[K]) => void;
  depths: RepositoryDetail["documentationDepths"];
  disabled: boolean;
  fieldErrors: Readonly<Record<string, string>>;
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const depth = depths.find((option) => option.id === draft.documentationDepth);
  const modeError = errorAt(fieldErrors, "documentation.check");
  const depthError = errorAt(fieldErrors, "documentation.depth");
  const targetsError = errorAt(fieldErrors, "documentation.updateTargets");

  return (
    <section className="or-repo-docs" aria-labelledby={titleId}>
      <h3 id={titleId} className="or-repo-docs__title">
        Documentation
      </h3>
      <p className="or-repo-docs__help">
        With each review, Om looks for documentation the change leaves wrong or incomplete.
      </p>
      <div className="or-field">
        <div className="or-field__head">
          <span className="or-field__label">Check</span>
        </div>
        <div className="or-field__control">
          <SegmentedControl<DocumentationCheckMode>
            aria-label="Documentation check"
            options={DOCUMENTATION_CHECK_MODES.map((mode) => ({
              value: mode,
              label: DOCUMENTATION_CHECK_LABELS[mode],
              disabled,
            }))}
            value={draft.documentationCheck}
            onValueChange={(value) => set("documentationCheck", value)}
          />
          <p className="or-repo-depth__summary">
            {documentationCheckHelp(provider, draft.documentationCheck)}
          </p>
          {modeError ? <p className="or-field-error">{modeError}</p> : null}
        </div>
      </div>
      <div className="or-field">
        <div className="or-field__head">
          <span className="or-field__label">Depth</span>
        </div>
        <div className="or-field__control">
          <SegmentedControl<DocumentationDepth>
            aria-label="Documentation depth"
            options={depths.map((option) => ({
              value: option.id,
              label: option.label,
              disabled,
            }))}
            value={draft.documentationDepth}
            onValueChange={(value) => set("documentationDepth", value)}
          />
          {depth ? (
            <div className="or-repo-depth">
              <p className="or-repo-depth__summary">{depth.summary}</p>
              <DetailsPopover
                label={`${depth.label} documentation check`}
                items={[
                  { term: "Model", detail: depth.details.model },
                  { term: "Token cap", detail: depth.details.tokenCap },
                  { term: "Iterations", detail: depth.details.iterations },
                  { term: "Reads", detail: depth.details.reads },
                ]}
              />
            </div>
          ) : null}
          {depthError ? <p className="or-field-error">{depthError}</p> : null}
        </div>
      </div>
      {draft.documentationCheck === "update" ? (
        <div className="or-field">
          <div className="or-field__head">
            <span className="or-field__label">Commit to</span>
          </div>
          <div className="or-field__control">
            <SegmentedControl<DocumentationUpdateTargets>
              aria-label="Commit documentation to"
              options={DOCUMENTATION_UPDATE_TARGETS.map((targets) => ({
                value: targets,
                label: documentationUpdateTargetsLabel(provider, targets),
                disabled,
              }))}
              value={draft.documentationUpdateTargets}
              onValueChange={(value) => set("documentationUpdateTargets", value)}
            />
            <p className="or-repo-depth__summary">
              {documentationUpdateTargetsHelp(provider, draft.documentationUpdateTargets)}
            </p>
            {targetsError ? <p className="or-field-error">{targetsError}</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The Reviews card (Design rule 12): its switch, when reviews start, the depth with its
 * summary and "<Depth> review profile", skip paths, reviewer instructions and the
 * Documentation section (`DocumentationSection`), staged in its
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
    saved,
    toChanges,
    save: useStagedSave({
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
    }),
    onDirtyChange: useUnsavedCard("Reviews", "reviews"),
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
                    { term: "Passes", detail: depth.details.passes },
                    { term: "Verification", detail: depth.details.verification },
                    { term: "Security", detail: depth.details.security },
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
        <DocumentationSection
          provider={provider}
          draft={draft}
          set={set}
          depths={detail.documentationDepths}
          disabled={disabled}
          fieldErrors={fieldErrors}
        />
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
