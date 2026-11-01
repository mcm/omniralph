"use client";

import {
  Button,
  Card,
  EmptyState,
  Field,
  SaveBar,
  TokenInput,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { useId, useMemo } from "react";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { api } from "@/lib/api/client";
import { connectionKeys } from "@/lib/api/keys";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";
import {
  fixLabelsRequestSchema,
  MAX_TRACKER_LABELS,
  trackerFixLabelsSchema,
  type TrackerFixLabelsView,
} from "@/lib/api/trackers";
import { useTrackerFixLabels } from "./queries";

/** The card's help line. */
export const FIX_LABELS_HELP =
  "A work item with one of these labels is a Fix; any other work item is a Story.";

/** Shown when the list is empty. */
export const NO_FIX_LABEL_ERROR = "Add at least one fix label.";

interface FixLabelsDraft {
  fixLabels: string[];
}

const sameLabels = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((label, i) => label === b[i]);

function toChanges(saved: FixLabelsDraft, draft: FixLabelsDraft): StagedChange[] {
  if (sameLabels(saved.fixLabels, draft.fixLabels)) return [];
  return [
    {
      id: "fixLabels",
      label: "Fix label",
      from: saved.fixLabels.join(", ") || "None",
      to: draft.fixLabels.join(", ") || "None",
    },
  ];
}

/** The error of a label the input can't add: blank, too long, a duplicate or one too many. */
function labelError(labels: readonly string[], value: string): string | null {
  const result = fixLabelsRequestSchema.shape.fixLabels.element.safeParse(value);
  if (!result.success) return result.error.issues[0]?.message ?? "This label is invalid.";
  const name = result.data.toLowerCase();
  if (labels.some((label) => label.toLowerCase() === name)) return "This label is already listed.";
  if (labels.length >= MAX_TRACKER_LABELS) return `Use at most ${MAX_TRACKER_LABELS} labels.`;
  return null;
}

function FixLabelsForm({
  view,
  isAdmin,
  history,
}: {
  view: TrackerFixLabelsView;
  isAdmin: boolean;
  history: SettingsHistoryEntry | null;
}) {
  const errorId = useId();
  const saved = useMemo<FixLabelsDraft>(() => ({ fixLabels: view.fixLabels }), [view.fixLabels]);
  const card = useStagedCard<FixLabelsDraft, TrackerFixLabelsView>({
    label: "Fix label",
    saved,
    toChanges,
    conflictMessage: "Another admin changed the fix labels while you were editing.",
    save: useStagedSave({
      request: (draft, { organizationId }) =>
        api.put(
          `/api/ui/trackers/${encodeURIComponent(view.integrationId)}/fix-labels`,
          trackerFixLabelsSchema,
          { body: { fixLabels: draft.fixLabels }, organizationId },
        ),
      applyResult: (result, cache) =>
        cache.set<TrackerFixLabelsView>(
          connectionKeys(cache.keys).fixLabels(view.integrationId),
          () => result,
          { exact: true },
        ),
    }),
    onDirtyChange: useUnsavedCard("Fix label", "fix-labels"),
  });
  const empty = card.draft.fixLabels.length === 0;
  const serverError =
    card.fieldErrors.fixLabels ??
    Object.entries(card.fieldErrors).find(([path]) => path.startsWith("fixLabels."))?.[1];
  const error = empty ? NO_FIX_LABEL_ERROR : serverError;

  return (
    <Card
      title="Fix label"
      titleId="fix-labels"
      titleAddon={
        <ChangeHistoryPopover section="connection" subject={view.integrationId} latest={history} />
      }
    >
      <p className="or-connection__note">{FIX_LABELS_HELP}</p>
      <Field label="Fix labels" htmlFor="fix-labels-input" stacked>
        <TokenInput
          id="fix-labels-input"
          values={card.draft.fixLabels}
          onChange={(values) => card.set("fixLabels", values)}
          placeholder={isAdmin ? "Add a label…" : undefined}
          mono={false}
          disabled={!isAdmin || card.saving}
          validate={(value) => labelError(card.draft.fixLabels, value)}
          aria-describedby={error ? errorId : undefined}
        />
        {error ? (
          <p id={errorId} className="or-field-error">
            {error}
          </p>
        ) : null}
      </Field>
      {isAdmin ? (
        <SaveBar
          changes={card.changes}
          onSave={() => {
            // An empty list is refused: the error shows under the field, nothing is sent.
            if (!empty) card.submit();
          }}
          onDiscard={card.discard}
          saving={card.saving}
          error={card.error}
          conflict={card.conflict}
        />
      ) : null}
      {card.dialog}
    </Card>
  );
}

/**
 * The Linear connection's "Fix label" card: the labels that mark a work item as a Fix (by
 * default `Bug`, matched ignoring case); every other work item is a Story. Admins stage the
 * list and save it in one `PUT …/fix-labels`, written into the cache from the answer; members
 * see it read-only. A live query: another admin's save arrives through the connection's
 * `connection` event.
 */
export function FixLabelsCard({
  integrationId,
  isAdmin,
  history,
}: {
  integrationId: string;
  isAdmin: boolean;
  history: SettingsHistoryEntry | null;
}) {
  const query = useTrackerFixLabels(integrationId);
  if (query.isPending) {
    return (
      <Card title="Fix label" titleId="fix-labels">
        <p aria-busy="true">Loading…</p>
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card title="Fix label" titleId="fix-labels">
        <EmptyState
          headingLevel={3}
          title="Couldn't load the fix labels"
          description={query.error.message}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      </Card>
    );
  }
  return <FixLabelsForm view={query.data} isAdmin={isAdmin} history={history} />;
}
