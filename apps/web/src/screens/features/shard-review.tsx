"use client";

import {
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Markdown,
  MetaBadge,
  Select,
  StatusText,
  TextInput,
  Textarea,
  type StatusTone,
} from "@omniralph/ui";
import { IconCheck, IconPencil, IconRestore, IconSitemap, IconTrash } from "@tabler/icons-react";
import { useId, useState } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useWorkItemTargets } from "@/components/work-items/use-create-work-item";
import {
  SHARD_DESCRIPTION_MAX_LENGTH,
  SHARD_TITLE_MAX_LENGTH,
  type FeatureShardDraftRow,
  type FeatureShardRow,
  type FeatureShardStatusValue,
  type FeatureShardView,
} from "@/lib/api/feature-shards";
import type { FeatureRow } from "@/lib/api/features";
import { useDiscardShard, useFileShard, useStartShard, useUpdateShardDraft } from "./mutations";
import { useFeatureShard } from "./queries";

export const EPICS_TITLE = "Epics";
export const SHARD_ACTION = "Shard into epics";
export const SHARD_AGAIN = "Shard again";
export const DISCARD_ACTION = "Discard drafts";
export const SHARD_HINT =
  "Om drafts the epics from the Plan, a verifier checks that every section is covered and that no epic adds scope the Plan lacks, and you review each draft before anything is filed.";
export const NO_SHARD = "No epics drafted yet";
export const SHARD_LOAD_FAILED = "Couldn't load the epic drafts";
export const DISCARDED_NOTE = "The last drafts were discarded.";
export const LEFTOVERS_TITLE = "Still open after the last round";
export const FILE_ACTION = (count: number) => `File ${count} ${count === 1 ? "epic" : "epics"}`;
export const UNDECIDED_HINT = (count: number) =>
  `Approve or remove every draft before filing (${count} left).`;
export const NO_TARGETS =
  "No repo picks up work items yet. Set a work item match on a repo with Coding on to file the epics.";
export const MAPPING_PARENT_ISSUE =
  "Each epic is filed under the feature's parent issue in the tracker and linked to this feature.";
export const MAPPING_OMNIRALPH =
  "Each epic is linked to this feature in Omniralph; the tracker shows them as separate epics.";
export const TRIAGE_NOTE = "Om then triages each filed epic into its tasks.";

const STATUS: Record<FeatureShardStatusValue, { label: string; tone: StatusTone }> = {
  drafting: { label: "Drafting", tone: "run" },
  review: { label: "Waiting for review", tone: "need" },
  filing: { label: "Filing", tone: "run" },
  filed: { label: "Filed", tone: "good" },
  failed: { label: "Failed", tone: "fail" },
  canceled: { label: "Discarded", tone: "neutral" },
};

const DECISION: Record<FeatureShardDraftRow["decision"], { label: string; tone: StatusTone }> = {
  pending: { label: "Pending review", tone: "need" },
  approved: { label: "Approved", tone: "good" },
  removed: { label: "Removed", tone: "neutral" },
};

/** "Round 2 of 3", or "Round 2" without a cap. */
function roundLabel(number: number, max: number | null): string {
  return max ? `Round ${number} of ${max}` : `Round ${number}`;
}

export interface ShardPanelProps {
  feature: FeatureRow;
  /** Starting, reviewing and filing allowed: an admin, on a feature that isn't archived. */
  editable: boolean;
}

/**
 * A feature's epics from its Plan: Shard into epics starts Om's loop (drafts, checked each
 * round until they pass or the cap); its rounds show while it drafts; then each draft shows
 * beside the Plan sections it covers, with the verifier's notes, and an editor edits, removes
 * or approves it before filing the approved ones in a repo's team. Members read. A live query.
 */
export function ShardPanel({ feature, editable }: ShardPanelProps) {
  const headingId = useId();
  const query = useFeatureShard(feature.id);
  const start = useStartShard(feature.id);
  const discard = useDiscardShard(feature.id);
  const [discarding, setDiscarding] = useState(false);
  const view = query.data;
  const shard = view?.shard ?? null;
  const active = shard !== null && ["drafting", "review", "filing"].includes(shard.status);

  let actions = null;
  if (editable && view) {
    actions = active ? (
      shard.status !== "filing" ? (
        <Button
          variant="outline"
          size="sm"
          icon={IconTrash}
          disabled={discard.isPending}
          onClick={() => setDiscarding(true)}
        >
          {DISCARD_ACTION}
        </Button>
      ) : null
    ) : (
      <Button
        variant={shard ? "outline" : "solid"}
        size="sm"
        icon={IconSitemap}
        disabled={start.isPending}
        onClick={() => start.mutate()}
      >
        {shard ? SHARD_AGAIN : SHARD_ACTION}
      </Button>
    );
  }

  return (
    <section className="or-feature-shard" aria-labelledby={headingId}>
      <div className="or-feature-files__head">
        <div className="or-feature-shard__heading">
          <h3 id={headingId} className="or-feature__section-title">
            {EPICS_TITLE}
          </h3>
          {shard ? (
            <StatusText tone={STATUS[shard.status].tone}>{STATUS[shard.status].label}</StatusText>
          ) : null}
        </div>
        {actions}
      </div>
      <p className="or-feature__hint">{SHARD_HINT}</p>

      {query.isError && !view ? (
        <EmptyState
          headingLevel={4}
          title={SHARD_LOAD_FAILED}
          description={query.error.message}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : !view ? null : !shard ? (
        <p className="or-feature__note">{NO_SHARD}</p>
      ) : (
        <ShardBody feature={feature} view={view} shard={shard} editable={editable} />
      )}

      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title="Discard the drafts?"
        description="The drafted epics are thrown away. Epics already filed stay in the tracker."
        confirmLabel={DISCARD_ACTION}
        destructive
        onConfirm={() => {
          setDiscarding(false);
          discard.mutate();
        }}
      />
    </section>
  );
}

function ShardBody({
  feature,
  view,
  shard,
  editable,
}: {
  feature: FeatureRow;
  view: FeatureShardView;
  shard: FeatureShardRow;
  editable: boolean;
}) {
  const reviewing = editable && shard.status === "review";
  return (
    <>
      {shard.status === "canceled" ? <p className="or-feature__note">{DISCARDED_NOTE}</p> : null}
      {shard.status === "failed" && shard.error ? (
        <p className="or-feature__error" role="alert">
          {shard.error}
        </p>
      ) : null}

      {shard.rounds.length > 0 ? (
        <ol className="or-feature-shard__rounds" aria-label="Rounds">
          {shard.rounds.map((round) => (
            <li key={round.number} className="or-feature-shard__round">
              <StatusText
                tone={
                  round.passed === true
                    ? "good"
                    : round.passed === false
                      ? "fail"
                      : round.status === "failed"
                        ? "fail"
                        : "run"
                }
              >
                {roundLabel(round.number, shard.maxRounds)}
                {round.passed === true
                  ? ": passed"
                  : round.passed === false
                    ? ": sent back"
                    : round.status === "verifying"
                      ? ": checking"
                      : round.status === "working"
                        ? ": drafting"
                        : ""}
              </StatusText>
              {round.summary ? (
                <span className="or-feature-shard__round-summary">{round.summary}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {shard.leftovers.length > 0 ? (
        <div className="or-feature__error" role="note" aria-label={LEFTOVERS_TITLE}>
          <strong>{LEFTOVERS_TITLE}</strong>
          <ul className="or-feature-shard__leftovers">
            {shard.leftovers.map((leftover, index) => (
              <li key={index}>{leftover}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {shard.drafts.length > 0 ? (
        <>
          {shard.summary ? <p className="or-feature-shard__summary">{shard.summary}</p> : null}
          <ol className="or-feature-shard__drafts" aria-label="Drafted epics">
            {shard.drafts.map((draft) => (
              <li key={draft.key}>
                <DraftCard
                  featureId={feature.id}
                  draft={draft}
                  drafts={shard.drafts}
                  sections={shard.sections}
                  reviewing={reviewing}
                />
              </li>
            ))}
          </ol>
          {shard.exempt.length > 0 ? (
            <div className="or-feature__note">
              <strong>Sections no epic needs</strong>
              <ul className="or-feature-shard__leftovers">
                {shard.exempt.map((exempt) => (
                  <li key={exempt.section}>
                    {exempt.section}: {exempt.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {reviewing ? <FileBar feature={feature} view={view} shard={shard} /> : null}
      {shard.status === "filed" ? <p className="or-feature__hint">{TRIAGE_NOTE}</p> : null}
    </>
  );
}

/** A Plan section's body, or a note when the Plan no longer has it. */
function sectionBody(sections: FeatureShardRow["sections"], name: string): string | null {
  const key = name.trim().toLowerCase();
  return sections.find((section) => section.name.trim().toLowerCase() === key)?.body ?? null;
}

function DraftCard({
  featureId,
  draft,
  drafts,
  sections,
  reviewing,
}: {
  featureId: string;
  draft: FeatureShardDraftRow;
  drafts: FeatureShardRow["drafts"];
  sections: FeatureShardRow["sections"];
  reviewing: boolean;
}) {
  const update = useUpdateShardDraft(featureId);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const decision = DECISION[draft.decision];
  const canChange = reviewing && !draft.filed;
  const after = draft.dependsOn.map(
    (key) => drafts.find((other) => other.key === key)?.title ?? key,
  );
  const titleProblem = !title.trim()
    ? "Give the epic a title."
    : title.trim().length > SHARD_TITLE_MAX_LENGTH
      ? `Keep the title to ${SHARD_TITLE_MAX_LENGTH} characters.`
      : null;
  const descriptionProblem = !description.trim()
    ? "Describe the epic."
    : description.length > SHARD_DESCRIPTION_MAX_LENGTH
      ? "The description is too long."
      : null;

  const save = () => {
    if (titleProblem || descriptionProblem) return;
    update.mutate(
      { key: draft.key, title: title.trim(), description: description.trim() },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <article
      className={["or-shard-draft", draft.decision === "removed" && "or-shard-draft--removed"]
        .filter(Boolean)
        .join(" ")}
      aria-label={`${draft.key}: ${draft.title}`}
    >
      <div className="or-shard-draft__main">
        <div className="or-shard-draft__head">
          <MetaBadge text={draft.key} mono />
          <h4 className="or-shard-draft__title">{draft.title}</h4>
          {draft.filed ? (
            <a
              className="or-shard-draft__filed"
              href={draft.filed.url}
              target="_blank"
              rel="noreferrer"
            >
              Filed as {draft.filed.identifier}
            </a>
          ) : (
            <StatusText tone={decision.tone}>{decision.label}</StatusText>
          )}
          {draft.edited ? <MetaBadge text="Edited" /> : null}
        </div>

        {editing ? (
          <div className="or-shard-draft__editor">
            <Field label="Title" stacked>
              <TextInput
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                errorMessage={titleProblem ?? undefined}
              />
            </Field>
            <Field
              label="Description"
              description="The epic in the epic format, in Markdown."
              stacked
            >
              <Textarea
                value={description}
                rows={14}
                mono
                onChange={(event) => setDescription(event.target.value)}
                errorMessage={descriptionProblem ?? undefined}
              />
            </Field>
            <div className="or-shard-draft__actions">
              <Button
                size="sm"
                disabled={update.isPending || Boolean(titleProblem || descriptionProblem)}
                onClick={save}
              >
                Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTitle(draft.title);
                  setDescription(draft.description);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Markdown className="or-shard-draft__description">{draft.description}</Markdown>
        )}

        {after.length > 0 ? <p className="or-feature__hint">After: {after.join(", ")}</p> : null}

        {draft.notes.length > 0 ? (
          <div className="or-shard-draft__notes">
            <span className="or-shard-draft__label">Verifier&apos;s notes</span>
            <ul>
              {draft.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {canChange && !editing ? (
          <div className="or-shard-draft__actions">
            {draft.decision === "approved" ? (
              <Button
                variant="outline"
                size="sm"
                icon={IconRestore}
                disabled={update.isPending}
                onClick={() => update.mutate({ key: draft.key, decision: "pending" })}
              >
                Unapprove
              </Button>
            ) : (
              <Button
                size="sm"
                icon={IconCheck}
                disabled={update.isPending}
                onClick={() => update.mutate({ key: draft.key, decision: "approved" })}
              >
                Approve
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              icon={IconPencil}
              onClick={() => {
                setTitle(draft.title);
                setDescription(draft.description);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            {draft.decision === "removed" ? (
              <Button
                variant="outline"
                size="sm"
                icon={IconRestore}
                disabled={update.isPending}
                onClick={() => update.mutate({ key: draft.key, decision: "pending" })}
              >
                Restore
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                icon={IconTrash}
                disabled={update.isPending}
                onClick={() => update.mutate({ key: draft.key, decision: "removed" })}
              >
                Remove
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <aside className="or-shard-draft__covers" aria-label={`Plan sections ${draft.key} covers`}>
        <span className="or-shard-draft__label">Covers</span>
        {draft.covers.length === 0 ? (
          <p className="or-feature__hint">No section of the Plan.</p>
        ) : (
          draft.covers.map((name) => {
            const body = sectionBody(sections, name);
            return (
              <details key={name} className="or-shard-draft__section">
                <summary>{name}</summary>
                {body ? (
                  <Markdown>{body}</Markdown>
                ) : (
                  <p className="or-feature__hint">The Plan has no section by this name.</p>
                )}
              </details>
            );
          })
        )}
      </aside>
    </article>
  );
}

/** Where the approved drafts are filed: a repo's team and project, and how the tracker shows them. */
function FileBar({
  feature,
  view,
  shard,
}: {
  feature: FeatureRow;
  view: FeatureShardView;
  shard: FeatureShardRow;
}) {
  const selectId = useId();
  const { organization } = useCurrentUser();
  const targets = useWorkItemTargets();
  const fileShard = useFileShard(feature.id);
  const options = (targets.data?.targets ?? []).filter(
    (target) => target.organization.id === organization.id,
  );
  const preferred = shard.repositoryId ?? feature.repository?.id ?? options[0]?.repository.id ?? "";
  const [chosen, setChosen] = useState<string | null>(null);
  const repositoryId = options.some((target) => target.repository.id === (chosen ?? preferred))
    ? (chosen ?? preferred)
    : (options[0]?.repository.id ?? "");
  const target = options.find((option) => option.repository.id === repositoryId);
  const pending = shard.drafts.filter((draft) => draft.decision === "pending").length;
  const approved = shard.drafts.filter((draft) => draft.decision === "approved").length;

  return (
    <div className="or-feature-shard__file">
      {shard.error ? (
        <p className="or-feature__error" role="alert">
          {shard.error}
        </p>
      ) : null}
      {targets.isSuccess && options.length === 0 ? (
        <p className="or-feature__note">{NO_TARGETS}</p>
      ) : (
        <Field
          label="File in"
          htmlFor={selectId}
          description={
            target
              ? `Team ${target.team}${target.project ? `, project ${target.project}` : ""}.`
              : undefined
          }
          stacked
        >
          <Select
            id={selectId}
            value={repositoryId}
            disabled={!targets.isSuccess}
            onChange={(event) => setChosen(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.repository.id} value={option.repository.id}>
                {option.repository.fullPath}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className="or-feature__hint">
        {view.featureMapping === "parent-issue"
          ? `${MAPPING_PARENT_ISSUE}${view.parentIssue ? ` (${view.parentIssue.identifier})` : ""}`
          : MAPPING_OMNIRALPH}{" "}
        {TRIAGE_NOTE}
      </p>
      {pending > 0 ? <p className="or-feature__hint">{UNDECIDED_HINT(pending)}</p> : null}
      <div className="or-shard-draft__actions">
        <Button
          variant="primary"
          disabled={fileShard.isPending || pending > 0 || approved === 0 || !repositoryId}
          onClick={() => fileShard.mutate({ repositoryId })}
        >
          {FILE_ACTION(approved)}
        </Button>
      </div>
    </div>
  );
}
