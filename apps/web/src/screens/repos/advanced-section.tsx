"use client";

import {
  Button,
  Card,
  Field,
  SaveBar,
  Select,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { useCallback, useMemo } from "react";
import type { z } from "zod";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { useShowAdvanced } from "@/components/show-advanced";
import { api } from "@/lib/api/client";
import {
  cardSaveResultSchema,
  playbooksCardSchema,
  type PlaybooksCard as PlaybooksCardData,
  type PlaybooksCardInput,
  type RepositoryDetail,
} from "@/lib/api/repositories";
import { playbookBindingEffect } from "@/lib/repositories/effects";
import { applySavedCard } from "./mutations";
import { REMOVE_REPO_DESCRIPTION } from "./remove-repo-dialog";
import { saveChangesLabel } from "./reviews-card";

const playbooksSaveResultSchema = cardSaveResultSchema(playbooksCardSchema);

type Binding = keyof PlaybooksCardData["choices"];

/** The card's selects, in order: the field label, its save-bar label and the runs' role. */
export const PLAYBOOK_BINDINGS: readonly {
  binding: Binding;
  label: string;
  changeLabel: string;
  role: string;
}[] = [
  { binding: "review", label: "Review", changeLabel: "Review playbook", role: "review" },
  {
    binding: "correlation",
    label: "Combine review findings",
    changeLabel: "Combine review findings playbook",
    role: "correlation",
  },
  { binding: "story", label: "Stories", changeLabel: "Stories playbook", role: "story" },
  { binding: "request", label: "Requests", changeLabel: "Requests playbook", role: "request" },
];

/**
 * The Playbooks card's fields, one per binding. Review is single-select (every repo runs one
 * review playbook); the API keeps an array, whose other entries a save leaves as they are.
 */
export type PlaybooksDraft = Record<Binding, string>;

function toDraft(card: PlaybooksCardData): PlaybooksDraft {
  return {
    review: card.bindings.review[0] ?? "",
    correlation: card.bindings.correlation,
    story: card.bindings.story,
    request: card.bindings.request,
  };
}

/** `PUT /api/ui/repositories/{id}/playbooks`'s body: every binding. */
export function playbooksInput(card: PlaybooksCardData, draft: PlaybooksDraft): PlaybooksCardInput {
  const rest = card.bindings.review.slice(1).filter((id) => id !== draft.review);
  return {
    bindings: {
      review: [draft.review, ...rest],
      correlation: draft.correlation,
      story: draft.story,
      request: draft.request,
    },
  };
}

/** A playbook's name among a binding's choices (its id when it isn't one of them). */
function playbookName(card: PlaybooksCardData, binding: Binding, id: string): string {
  return card.choices[binding].find((choice) => choice.id === id)?.name ?? id;
}

/** The save bar's items: each binding that differs, in the card's order, with its effect. */
export function playbooksChanges(
  card: PlaybooksCardData,
  saved: PlaybooksDraft,
  draft: PlaybooksDraft,
): StagedChange[] {
  return PLAYBOOK_BINDINGS.filter(({ binding }) => draft[binding] !== saved[binding]).map(
    ({ binding, changeLabel, role }) =>
      playbookBindingEffect(
        binding,
        changeLabel,
        role,
        playbookName(card, binding, saved[binding]),
        playbookName(card, binding, draft[binding]),
      ),
  );
}

/**
 * The Playbooks card: one select per binding, the built-in playbook first, then the
 * organization's playbooks of that role, staged in its save bar and saved in one request
 * (`PUT /api/ui/repositories/{id}/playbooks`). Members see it read-only.
 */
export function PlaybooksCard({ detail }: { detail: RepositoryDetail }) {
  const { repository, canEdit, playbooks } = detail;
  const saved = useMemo(() => toDraft(playbooks), [playbooks]);
  const toChanges = useCallback(
    (from: PlaybooksDraft, to: PlaybooksDraft) => playbooksChanges(playbooks, from, to),
    [playbooks],
  );
  const card = useStagedCard<PlaybooksDraft, z.infer<typeof playbooksSaveResultSchema>>({
    label: "Playbooks",
    saved,
    toChanges,
    save: useStagedSave({
      request: (draft, { organizationId }) =>
        api.put(
          `/api/ui/repositories/${encodeURIComponent(repository.id)}/playbooks`,
          playbooksSaveResultSchema,
          { body: playbooksInput(playbooks, draft), organizationId },
        ),
      applyResult: (result, cache) =>
        applySavedCard(cache, repository.id, (previous) => ({
          ...previous,
          playbooks: result.card,
        })),
    }),
    onDirtyChange: useUnsavedCard("Playbooks"),
  });
  const disabled = !canEdit || card.saving;

  return (
    <Card
      title="Playbooks"
      headingLevel={3}
      className="or-repo-card"
      titleAddon={
        <ChangeHistoryPopover
          section="repository.playbooks"
          subject={repository.id}
          organization={repository.organization.id}
          latest={detail.history.playbooks}
        />
      }
    >
      <p className="or-repo-card__help">Om runs this repo&apos;s work with these playbooks.</p>
      <div className="or-repo-card__fields">
        {PLAYBOOK_BINDINGS.map(({ binding, label }) => {
          const choices = playbooks.choices[binding];
          const value = card.draft[binding];
          const known = choices.some((choice) => choice.id === value);
          const error = Object.entries(card.fieldErrors).find(
            ([path]) => path === `bindings.${binding}` || path.startsWith(`bindings.${binding}.`),
          )?.[1];
          return (
            <Field key={binding} label={label}>
              <Select
                value={value}
                disabled={disabled}
                onChange={(event) => card.set(binding, event.target.value)}
                errorMessage={error}
              >
                {known ? null : <option value={value}>{value}</option>}
                {[...choices]
                  // The built-in playbooks first, then the organization's own.
                  .sort((a, b) => Number(b.builtin) - Number(a.builtin))
                  .map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.name}
                    </option>
                  ))}
              </Select>
            </Field>
          );
        })}
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

/** The bottom of the page (admins only): removing the repo, through `RemoveRepoDialog`. */
export function DangerZone({ onRemove }: { onRemove: () => void }) {
  return (
    <Card title="Danger zone" headingLevel={3} className="or-repo-card or-repo-danger">
      <div className="or-repo-danger__row">
        <p className="or-repo-danger__text">{REMOVE_REPO_DESCRIPTION}</p>
        <Button variant="danger" onClick={onRemove}>
          Remove repo
        </Button>
      </div>
    </Card>
  );
}

/**
 * The Advanced section: its h2, then the Playbooks card (h3), only while the viewer shows advanced settings
 * (the preference only shows or hides it: bindings apply either way), then the Danger zone (h3)
 * for admins. `onRemove` opens the page's one `RemoveRepoDialog`.
 */
export function AdvancedSection({
  detail,
  titleId,
  onRemove,
}: {
  detail: RepositoryDetail;
  titleId: string;
  onRemove: () => void;
}) {
  const [advancedVisible] = useShowAdvanced();
  return (
    <>
      <h2 id={titleId} className="or-repo-section__title">
        Advanced
      </h2>
      {advancedVisible ? <PlaybooksCard detail={detail} /> : null}
      {detail.canEdit ? <DangerZone onRemove={onRemove} /> : null}
    </>
  );
}
