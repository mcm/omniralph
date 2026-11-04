"use client";

import {
  BranchBadge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  MetaBadge,
  StatusText,
  Switch,
  TextInput,
} from "@omniralph/ui";
import { IconGripVertical, IconX } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useCurrentUser } from "@/components/current-user";
import { ApiError } from "@/lib/api/client";
import type { SprintEpicRow, SprintRow } from "@/lib/api/sprints";
import type { WorkItemRow } from "@/lib/api/work-items";
import { useDeleteSprint, useSprintAction, useUpdateSprint, type SprintChange } from "./mutations";
import { useRepoBacklog, useSprint } from "./queries";
import {
  SPRINT_ACTION_LABELS,
  SPRINT_ACTIONS,
  SPRINT_STATUS,
  SPRINTS_PATH,
  type SprintAction,
} from "./sprint-status";
import "./sprints.css";

export const SPRINT_NOT_FOUND = "That sprint doesn't exist";
export const SPRINT_LOAD_FAILED = "Couldn't load the sprint";
export const LOADING_SPRINT = "Loading the sprint…";

export const NAME_EXPLANATION = "Shown on the Backlog beside each of its epics.";
export const MERGE_TOGETHER_EXPLANATION =
  "Epic PRs merge into a sprint branch once CI passes and every finding is addressed; a person approves one sprint PR at the end.";
export const ORDER_EXPLANATION =
  "Om builds the epics top to bottom. Drag an epic, or focus its handle and press ↑ or ↓, to move it.";
export const ADD_EXPLANATION =
  "Open work items of this repo that aren't in the sprint. Add an epic to put it at the end.";
export const READ_ONLY_MEMBER = "Only admins can change sprints.";
export const READ_ONLY_STARTED = "A started sprint keeps its name, setting and order.";
export const PAUSED_HINT = "Fix what's in the way, then resume: Om retries the stalled epic first.";

/** Handles a sprint action (Start, Pause, Resume, Cancel); by default it's sent to the API. */
export type SprintActionHandler = (sprint: SprintRow, action: SprintAction) => void;

/** The epic states as a person reads them. */
const EPIC_STATE_LABELS: Record<SprintEpicRow["state"], string> = {
  queued: "Queued",
  running: "Running",
  merged: "Merged",
  stalled: "Stalled",
};

/** `items` with the one at `from` moved to `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Whether the user may change the active organization's sprints. */
function useIsAdmin(): boolean {
  return useCurrentUser().role === "admin";
}

function SprintDetailSkeleton() {
  return (
    <div className="or-sprint" role="status" data-testid="sprint-skeleton">
      <span className="or-sr-only">{LOADING_SPRINT}</span>
      <div className="or-sprint-skeleton" aria-hidden="true">
        <div className="or-sprint-skeleton__line or-sprint-skeleton__line--title" />
        <div className="or-sprint-skeleton__line or-sprint-skeleton__line--short" />
        {[0, 1, 2].map((index) => (
          <div key={index} className="or-sprint-skeleton__row" />
        ))}
      </div>
    </div>
  );
}

export interface SprintDetailViewProps {
  sprintId: string;
  onAction?: SprintActionHandler;
}

/**
 * One sprint beside the Sprints list: a skeleton while it loads, "That sprint doesn't
 * exist" for an unknown ID, a retry when it can't load, else the editor. A live query.
 */
export function SprintDetailView({ sprintId, onAction }: SprintDetailViewProps) {
  const sprint = useSprint(sprintId);
  if (sprint.isPending) return <SprintDetailSkeleton />;
  if (sprint.isError) {
    if (sprint.error instanceof ApiError && sprint.error.status === 404) {
      return (
        <EmptyState
          className="or-sprint__empty"
          title={SPRINT_NOT_FOUND}
          action={
            <Button variant="outline" href={SPRINTS_PATH}>
              Back to Sprints
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        className="or-sprint__empty"
        title={SPRINT_LOAD_FAILED}
        description={sprint.error.message}
        action={
          <Button variant="outline" onClick={() => void sprint.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return <SprintEditor sprint={sprint.data} onAction={onAction} />;
}

/** The buttons the sprint's status allows, with one line on what they do. Admins only. */
function SprintActions({
  sprint,
  onAction,
  onDelete,
}: {
  sprint: SprintRow;
  onAction?: SprintActionHandler;
  onDelete: () => void;
}) {
  const sprintAction = useSprintAction();
  const act: SprintActionHandler =
    onAction ?? ((target, action) => sprintAction.mutate({ sprint: target, action }));
  const { actions, explanation } = SPRINT_ACTIONS[sprint.status];
  if (actions.length === 0 && sprint.status !== "draft") return null;
  return (
    <div className="or-sprint__actions">
      <div className="or-sprint__buttons" role="group" aria-label="Sprint actions">
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === "start" || action === "resume" ? "solid" : "outline"}
            size="sm"
            disabled={sprintAction.isPending || (action === "start" && sprint.epics.length === 0)}
            disabledReason={
              action === "start" && sprint.epics.length === 0 ? "Add an epic first." : undefined
            }
            onClick={() => act(sprint, action)}
          >
            {SPRINT_ACTION_LABELS[action]}
          </Button>
        ))}
        {sprint.status === "draft" ? (
          <Button variant="ghost" size="sm" onClick={onDelete}>
            Delete draft…
          </Button>
        ) : null}
      </div>
      {explanation ? <p className="or-sprint__hint">{explanation}</p> : null}
    </div>
  );
}

/** Where a refusal shows: under the name, under the switch, or above the epics. */
type ErrorPlace = "name" | "mergeTogether" | "epics";

function errorPlace(change: SprintChange): ErrorPlace {
  if (change.epics) return "epics";
  if (change.mergeTogether !== undefined) return "mergeTogether";
  return "name";
}

export interface SprintEditorProps {
  sprint: SprintRow;
  onAction?: SprintActionHandler;
}

/**
 * A sprint (Design board Sprints): its name, status, repo and branch, the actions its status
 * allows, the name and Merge together settings, and its epics in order. An admin edits a
 * draft: renames it (saved on Enter or leaving the field), switches Merge together, adds
 * epics from the repo's backlog, removes them and reorders them by drag or with ↑/↓ on an
 * epic's handle. Each change saves at once; one the API refuses puts back what was there and
 * shows the API's message where it was made. Members, and everyone once a sprint has started,
 * see it all read-only.
 */
export function SprintEditor({ sprint, onAction }: SprintEditorProps) {
  const router = useRouter();
  const admin = useIsAdmin();
  const editable = admin && sprint.status === "draft";
  const nameId = useId();
  const mergeHintId = useId();
  const orderHintId = useId();

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ErrorPlace, string>>>({});
  const [announcement, setAnnouncement] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = useUpdateSprint(sprint, {
    onSuccess: (change) => {
      setErrors((previous) => ({ ...previous, [errorPlace(change)]: undefined }));
      if (change.name !== undefined) setNameDraft(null);
    },
    onError: (error, change) =>
      setErrors((previous) => ({ ...previous, [errorPlace(change)]: error.message })),
  });
  const remove = useDeleteSprint(sprint, () => router.push(SPRINTS_PATH));

  const epics = sprint.epics;
  const change = (next: SprintChange) => update.mutate(next);

  const saveName = () => {
    if (nameDraft === null) return;
    const name = nameDraft.trim();
    if (name === sprint.name) {
      setNameDraft(null);
      setErrors((previous) => ({ ...previous, name: undefined }));
      return;
    }
    if (name === "") {
      setErrors((previous) => ({ ...previous, name: "Name the sprint." }));
      return;
    }
    change({ name });
  };

  // Keyboard moves keep focus on the moved epic's handle.
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterMove.current;
    if (id === null) return;
    focusAfterMove.current = null;
    handles.current.get(id)?.focus();
  }, [epics]);

  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || to >= epics.length || from === to) return;
    const moved = epics[from]!;
    setAnnouncement(`Moved ${moved.identifier} to position ${to + 1} of ${epics.length}.`);
    change({ epics: moveItem(epics, from, to) });
  };

  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to =
      event.key === "ArrowUp"
        ? index - 1
        : event.key === "ArrowDown"
          ? index + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? epics.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    focusAfterMove.current = epics[index]!.workItemId;
    move(index, to);
  };

  // Drag and drop: the dragged epic lands where the one under the pointer is. The dragged
  // epic is kept in a ref too, so the drop reads it even before a re-render.
  const [dragging, setDragging] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const endDrag = () => {
    draggingRef.current = null;
    setDragging(null);
    setOver(null);
  };
  const dragProps = (epic: SprintEpicRow, index: number) =>
    editable
      ? {
          draggable: true,
          onDragStart: (event: DragEvent<HTMLLIElement>) => {
            event.dataTransfer?.setData("text/plain", epic.workItemId);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            draggingRef.current = epic.workItemId;
            setDragging(epic.workItemId);
          },
          onDragOver: (event: DragEvent<HTMLLIElement>) => {
            if (draggingRef.current === null) return;
            event.preventDefault();
            setOver(epic.workItemId);
          },
          onDrop: (event: DragEvent<HTMLLIElement>) => {
            const dragged = draggingRef.current;
            if (dragged === null) return;
            event.preventDefault();
            endDrag();
            move(
              epics.findIndex((entry) => entry.workItemId === dragged),
              index,
            );
          },
          onDragEnd: endDrag,
        }
      : {};

  const addEpic = (row: WorkItemRow) =>
    change({
      epics: [
        ...epics,
        { workItemId: row.id, identifier: row.identifier, title: row.title, state: "queued" },
      ],
    });
  const removeEpic = (index: number) =>
    change({ epics: epics.filter((_, position) => position !== index) });

  const status = SPRINT_STATUS[sprint.status];

  return (
    <article className="or-sprint" aria-label={sprint.name}>
      <header className="or-sprint__head">
        <h2 className="or-sprint__title">{sprint.name}</h2>
        <div className="or-sprint__badges">
          <StatusText tone={status.tone}>{status.label}</StatusText>
          <MetaBadge text={sprint.repository.fullPath} mono />
          {sprint.sprintBranch ? <BranchBadge name={sprint.sprintBranch} /> : null}
        </div>
      </header>

      {sprint.status === "paused" && sprint.pausedReason ? (
        <div className="or-sprint__paused" role="status">
          <p className="or-sprint__paused-reason">{sprint.pausedReason}</p>
          {admin ? <p className="or-sprint__hint">{PAUSED_HINT}</p> : null}
        </div>
      ) : null}

      {admin ? (
        <SprintActions
          sprint={sprint}
          onAction={onAction}
          onDelete={() => setConfirmDelete(true)}
        />
      ) : null}

      {!editable ? (
        <p className="or-sprint__note">{admin ? READ_ONLY_STARTED : READ_ONLY_MEMBER}</p>
      ) : null}

      <section className="or-sprint__section" aria-labelledby={`${nameId}-settings`}>
        <h3 id={`${nameId}-settings`} className="or-sr-only">
          Settings
        </h3>
        {editable ? (
          <Field label="Name" description={NAME_EXPLANATION} stacked>
            <TextInput
              value={nameDraft ?? sprint.name}
              maxLength={100}
              errorMessage={errors.name}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveName();
                }
                if (event.key === "Escape" && nameDraft !== null) {
                  event.preventDefault();
                  setNameDraft(null);
                  setErrors((previous) => ({ ...previous, name: undefined }));
                }
              }}
            />
          </Field>
        ) : null}
        <div className="or-sprint__switch">
          {editable ? (
            <Switch
              label="Merge together"
              checked={sprint.mergeTogether}
              aria-describedby={mergeHintId}
              onCheckedChange={(mergeTogether) => change({ mergeTogether })}
            />
          ) : (
            <p className="or-sprint__setting">
              Merge together: <strong>{sprint.mergeTogether ? "On" : "Off"}</strong>
            </p>
          )}
          <p id={mergeHintId} className="or-sprint__hint">
            {MERGE_TOGETHER_EXPLANATION}
          </p>
          {errors.mergeTogether ? (
            <p className="or-sprint__error" role="alert">
              {errors.mergeTogether}
            </p>
          ) : null}
        </div>
      </section>

      <section className="or-sprint__section" aria-labelledby={`${nameId}-epics`}>
        <h3 id={`${nameId}-epics`} className="or-sprint__section-title">
          Epics <MetaBadge text={String(epics.length)} mono />
        </h3>
        {editable ? (
          <p id={orderHintId} className="or-sprint__hint">
            {ORDER_EXPLANATION}
          </p>
        ) : null}
        {errors.epics ? (
          <p className="or-sprint__error" role="alert">
            {errors.epics}
          </p>
        ) : null}
        <p className="or-sr-only" aria-live="polite">
          {announcement}
        </p>
        {epics.length === 0 ? (
          <p className="or-sprint__placeholder">
            {editable
              ? "No epics yet. Add them from the repo's backlog below."
              : "This sprint has no epics."}
          </p>
        ) : (
          <ol className="or-sprint__epics" aria-label="Epics in order">
            {epics.map((epic, index) => (
              <li
                key={epic.workItemId}
                className={[
                  "or-sprint-epic",
                  dragging === epic.workItemId && "or-sprint-epic--dragging",
                  over === epic.workItemId &&
                    dragging !== epic.workItemId &&
                    "or-sprint-epic--over",
                ]
                  .filter(Boolean)
                  .join(" ")}
                {...dragProps(epic, index)}
              >
                {editable ? (
                  <button
                    type="button"
                    className="or-sprint-epic__handle"
                    aria-label={`Move ${epic.identifier}, position ${index + 1} of ${epics.length}`}
                    aria-describedby={orderHintId}
                    ref={(element) => {
                      if (element) handles.current.set(epic.workItemId, element);
                      else handles.current.delete(epic.workItemId);
                    }}
                    onKeyDown={(event) => onHandleKey(event, index)}
                  >
                    <IconGripVertical size={16} stroke={1.75} aria-hidden="true" />
                  </button>
                ) : (
                  <span className="or-sprint-epic__position or-mono" aria-hidden="true">
                    {index + 1}
                  </span>
                )}
                <span className="or-sprint-epic__identifier or-mono">{epic.identifier}</span>
                <span className="or-sprint-epic__title">{epic.title}</span>
                {sprint.status !== "draft" ? (
                  <span className="or-sprint-epic__state">{EPIC_STATE_LABELS[epic.state]}</span>
                ) : null}
                {editable ? (
                  <IconButton
                    icon={IconX}
                    size="sm"
                    label={`Remove ${epic.identifier}`}
                    onClick={() => removeEpic(index)}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {editable ? (
        <AddFromBacklog sprint={sprint} onAdd={addEpic} pending={update.isPending} />
      ) : null}

      {sprint.status === "draft" && admin ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${sprint.name}?`}
          description="The draft and its order go away. Its epics stay in the backlog."
          confirmLabel="Delete draft"
          destructive
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </article>
  );
}

/** The backlog rows a sprint can take: open, not manual, not already in it. */
export function sprintCandidates(
  rows: readonly WorkItemRow[],
  sprint: Pick<SprintRow, "epics">,
): WorkItemRow[] {
  const inSprint = new Set(sprint.epics.map((epic) => epic.workItemId));
  return rows.filter((row) => !row.manual && !inSprint.has(row.id));
}

/** Add from the backlog: the repo's open work items not in the sprint, each with Add. */
function AddFromBacklog({
  sprint,
  onAdd,
  pending,
}: {
  sprint: SprintRow;
  onAdd: (row: WorkItemRow) => void;
  pending: boolean;
}) {
  const headingId = useId();
  const backlog = useRepoBacklog(sprint.repository.id, true);
  const data = backlog.data;
  const rows = data
    ? sprintCandidates(
        [...data.groups.readyToStart, ...data.groups.needsRefining, ...data.groups.upNext],
        sprint,
      )
    : [];

  let body: ReactNode;
  if (backlog.isError && !data) {
    body = (
      <div className="or-sprint__error" role="alert">
        <p>Couldn&apos;t load the backlog. {backlog.error.message}</p>
        <Button variant="outline" size="sm" onClick={() => void backlog.refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (!data) {
    body = (
      <div role="status" className="or-sprint-skeleton" data-testid="sprint-backlog-skeleton">
        <span className="or-sr-only">Loading the backlog…</span>
        <div aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="or-sprint-skeleton__row" />
          ))}
        </div>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <p className="or-sprint__placeholder">
        {data.groups.readyToStart.length + data.groups.needsRefining.length > 0
          ? "Every open work item of this repo is in the sprint."
          : "Nothing in this repo's backlog."}
      </p>
    );
  } else {
    body = (
      <ul className="or-sprint__candidates" aria-label="Backlog">
        {rows.map((row) => (
          <li key={row.id} className="or-sprint-epic">
            <span className="or-sprint-epic__identifier or-mono">{row.identifier}</span>
            <span className="or-sprint-epic__title">{row.title}</span>
            <span className="or-sprint-epic__state">
              {row.blocked && row.blockers.length > 0
                ? `Blocked by ${row.blockers.join(", ")}`
                : row.kind === null
                  ? "Epic"
                  : "Task"}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Add ${row.identifier}`}
              disabled={pending}
              onClick={() => onAdd(row)}
            >
              Add
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="or-sprint__section" aria-labelledby={headingId}>
      <h3 id={headingId} className="or-sprint__section-title">
        Add from the backlog
      </h3>
      <p className="or-sprint__hint">{ADD_EXPLANATION}</p>
      {body}
    </section>
  );
}
