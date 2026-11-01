"use client";

import { Button, EmptyState, Markdown, Textarea } from "@omniralph/ui";
import { IconPencil } from "@tabler/icons-react";
import { useEffect, useId, useState } from "react";
import { ApiError } from "@/lib/api/client";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { useSavePrd } from "./use-save-prd";
import { useWorkItemDetail } from "./use-work-item-detail";
import "./prd-view.css";

/** The detail failed to load (other than a 404). */
export const PRD_LOAD_FAILED = "Couldn't load the PRD.";
/** The item doesn't exist, or isn't in one of the user's organizations. */
export const PRD_NOT_FOUND = "This work item doesn't exist or you can't see it.";
/** The item has no description yet. */
export const PRD_EMPTY = "No PRD yet";

export interface PrdViewProps {
  /** The work item's URL ID (`<tracker>-<issue id>`). */
  workItemId: string;
  /**
   * `editable`: Edit PRD swaps the rendered PRD for an editor, when the item allows it
   * (`actions.editPrd`; else it renders read-only). `read-only`: no edit control.
   */
  mode: "editable" | "read-only";
  /**
   * Opens the editor (editable mode, when the item allows it): the detail toolbar's Edit
   * PRD. `onEditStarted` is called once it's open, to clear the request.
   */
  editRequested?: boolean;
  onEditStarted?: () => void;
  /** Shows the pane's own Edit PRD button. Off where a toolbar has one. Defaults to true. */
  showEditButton?: boolean;
}

/** The edit in progress: the text and the `updatedAt` it started from. */
interface Draft {
  text: string;
  base: string;
  /** The text the edit started from: Save is disabled until the draft differs. */
  original: string;
  /** Why the last Save was refused (a 409), shown over the editor. */
  error: string | null;
}

/** A new edit of the item's current PRD. */
function startEditingDraft(item: WorkItemDetail): Draft {
  return { text: item.description, original: item.description, base: item.updatedAt, error: null };
}

/**
 * A work item's PRD (its description), rendered by `Markdown` in a 68ch column, loaded
 * live through `GET /api/ui/work-items/{id}`. In editable mode Edit PRD swaps it for a
 * mono `Textarea` with Save and Cancel. Save shows the new text at once; when the server
 * refuses it (the item changed in the tracker, or Om is working on it) the editor comes
 * back with the user's text and the reason. Live refetches never touch a draft.
 */
export function PrdView({
  workItemId,
  mode,
  editRequested = false,
  onEditStarted,
  showEditButton = true,
}: PrdViewProps) {
  const detail = useWorkItemDetail(workItemId);
  if (detail.isPending) {
    return (
      <div className="or-prd" aria-busy="true" aria-label="Loading the PRD">
        <div className="or-prd__skeleton" aria-hidden="true">
          <div className="or-prd__skeleton-line or-prd__skeleton-line--short" />
          <div className="or-prd__skeleton-line" />
          <div className="or-prd__skeleton-line" />
        </div>
      </div>
    );
  }
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <EmptyState className="or-prd" title={PRD_NOT_FOUND} />;
    }
    return (
      <div className="or-prd">
        <p className="or-prd__error" role="alert">
          {PRD_LOAD_FAILED}
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            Retry
          </Button>
        </p>
      </div>
    );
  }
  return (
    <PrdContent
      key={workItemId}
      item={detail.data}
      mode={mode}
      editRequested={editRequested}
      onEditStarted={onEditStarted}
      showEditButton={showEditButton}
    />
  );
}

function PrdContent({
  item,
  mode,
  editRequested,
  onEditStarted,
  showEditButton,
}: {
  item: WorkItemDetail;
  mode: PrdViewProps["mode"];
  editRequested: boolean;
  onEditStarted?: () => void;
  showEditButton: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useSavePrd(item.id);
  const editorId = useId();
  const alertId = useId();
  const canEdit = mode === "editable" && item.actions.editPrd;
  const startEditing = () => setDraft(startEditingDraft(item));

  // The toolbar's Edit PRD: open the editor (unless one is open already), then clear the
  // request.
  if (editRequested && draft === null && canEdit && !save.isPending) {
    setDraft(startEditingDraft(item));
  }
  useEffect(() => {
    if (editRequested) onEditStarted?.();
  }, [editRequested, onEditStarted]);

  // An edit in progress stays open even if the item stops being editable meanwhile (a run
  // started): Save then says why, and the text is never lost.
  if (draft) {
    const unchanged = draft.text === draft.original;
    const submit = () => {
      const { text, base } = draft;
      setDraft(null);
      save.mutate(
        { markdown: text, baseUpdatedAt: base },
        {
          onError: (error) =>
            setDraft({
              ...draft,
              text,
              error: error instanceof ApiError && error.status === 409 ? error.message : null,
            }),
        },
      );
    };
    return (
      <form
        className="or-prd or-prd--editing"
        onSubmit={(event) => {
          event.preventDefault();
          if (!unchanged) submit();
        }}
      >
        {draft.error ? (
          <p id={alertId} className="or-prd__error" role="alert">
            {draft.error}
          </p>
        ) : null}
        <label className="or-sr-only" htmlFor={editorId}>
          PRD of {item.identifier} (Markdown)
        </label>
        <Textarea
          id={editorId}
          mono
          rows={24}
          className="or-prd__editor"
          value={draft.text}
          aria-describedby={draft.error ? alertId : undefined}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        />
        <div className="or-prd__actions">
          <Button type="submit" variant="solid" disabled={unchanged}>
            Save
          </Button>
          <Button type="button" variant="outline" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="or-prd">
      {canEdit && showEditButton ? (
        <div className="or-prd__actions">
          <Button
            variant="outline"
            size="sm"
            icon={IconPencil}
            disabled={save.isPending}
            onClick={startEditing}
          >
            Edit PRD
          </Button>
        </div>
      ) : null}
      {item.description.trim() === "" ? (
        <EmptyState title={PRD_EMPTY} headingLevel={3} />
      ) : (
        <Markdown className="or-prd__body">{item.description}</Markdown>
      )}
    </div>
  );
}
