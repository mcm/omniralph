"use client";

import { Card, SaveBar, Switch } from "@omniralph/ui";
import { useMemo } from "react";
import type { z } from "zod";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { useStagedCard, type StagedChange } from "@/components/use-staged-card";
import { api } from "@/lib/api/client";
import {
  askCardSchema,
  cardSaveResultSchema,
  type AskCardInput,
  type RepositoryDetail,
} from "@/lib/api/repositories";
import { askEnabledEffect } from "@/lib/repositories/effects";
import { applySavedCard } from "./mutations";
import { saveChangesLabel } from "./reviews-card";

const askSaveResultSchema = cardSaveResultSchema(askCardSchema);

/** The Ask card's one field, as `useStagedCard` stages it. */
export interface AskDraft {
  enabled: boolean;
}

/** `PUT /api/ui/repositories/{id}/ask`'s body. */
export function askInput(draft: AskDraft): AskCardInput {
  return { askEnabled: draft.enabled };
}

/** The save bar's item: the switch, with its effect, when it differs. */
export function askChanges(saved: AskDraft, draft: AskDraft): StagedChange[] {
  return draft.enabled === saved.enabled ? [] : [askEnabledEffect(draft.enabled)];
}

/**
 * The Ask card (Design rule 12): the third peer of Reviews and Coding, with the same switch
 * in its head, a help line and its own save bar, saved in one request
 * (`PUT /api/ui/repositories/{id}/ask`). Members see it read-only.
 */
export function AskCard({ detail, titleId }: { detail: RepositoryDetail; titleId: string }) {
  const { repository, canEdit } = detail;
  const saved = useMemo<AskDraft>(() => ({ enabled: detail.ask.enabled }), [detail.ask.enabled]);
  const card = useStagedCard<AskDraft, z.infer<typeof askSaveResultSchema>>({
    label: "Ask",
    anchorId: "ask",
    saved,
    toChanges: askChanges,
    save: {
      request: (draft, { organizationId }) =>
        api.put(
          `/api/ui/repositories/${encodeURIComponent(repository.id)}/ask`,
          askSaveResultSchema,
          { body: askInput(draft), organizationId },
        ),
      applyResult: (result, cache) =>
        applySavedCard(
          cache,
          repository.id,
          (previous) => ({ ...previous, ask: result.card }),
          (row) => ({ ...row, askEnabled: result.card.enabled }),
        ),
    },
  });
  const askError = card.fieldErrors.askEnabled;

  return (
    <Card
      title="Ask"
      titleId={titleId}
      className="or-repo-card"
      titleAddon={
        <ChangeHistoryPopover
          section="repository.ask"
          subject={repository.id}
          organization={repository.organization.id}
          latest={detail.history.ask}
        />
      }
      actions={
        <Switch
          aria-label="Ask"
          checked={card.draft.enabled}
          disabled={!canEdit || card.saving}
          onCheckedChange={(checked) => card.set("enabled", checked)}
        />
      }
    >
      <p className="or-repo-card__help">
        Om answers questions about this repo&apos;s code in Ask and chat.
      </p>
      {askError ? <p className="or-field-error">{askError}</p> : null}
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
