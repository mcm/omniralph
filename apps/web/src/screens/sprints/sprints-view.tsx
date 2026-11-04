"use client";

import {
  Button,
  EmptyState,
  IconButton,
  ListRow,
  MetaBadge,
  RowList,
  rowListProps,
  SplitView,
  useSplitWide,
} from "@omniralph/ui";
import { IconPlus } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { useCurrentUser } from "@/components/current-user";
import { NEW_SPRINT, NewSprintSheet } from "./new-sprint-sheet";
import { useSprintList } from "./queries";
import { SprintDetailView, type SprintActionHandler } from "./sprint-editor";
import { epicCount, SPRINT_STATUS, sprintHref, sprintsByRepo, SPRINTS_PATH } from "./sprint-status";
import "./sprints.css";

export const NO_SPRINTS = "No sprints yet";
export const NO_SPRINTS_DESCRIPTION =
  "A sprint lines up epics of one repo; Om starts each one when the one before merges.";
export const SPRINTS_LOAD_FAILED = "Couldn't load sprints";
export const LOADING_SPRINTS = "Loading sprints…";

export interface SprintsViewProps {
  /** The open sprint (`/sprints/{id}`); none on `/sprints`. */
  sprintId?: string | null;
  /** The detail beside the list; `SprintDetailView` by default. */
  renderDetail?: (sprintId: string) => ReactNode;
  /** Runs Start, Pause, Resume and Cancel; without it their buttons are disabled. */
  onAction?: SprintActionHandler;
}

function SprintListSkeleton() {
  return (
    <div className="or-sprints-skeleton" role="status" data-testid="sprints-skeleton">
      <span className="or-sr-only">{LOADING_SPRINTS}</span>
      <div aria-hidden="true">
        <div className="or-sprints-skeleton__heading" />
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="or-sprints-skeleton__row" />
        ))}
      </div>
    </div>
  );
}

/**
 * The Sprints screen (Design board Sprints): the list with "Sprints", the + (New sprint,
 * admins) and the active organization's sprints grouped by repo, each with its name, status
 * and epic count, beside the open sprint (on `/sprints`, the first one, when both panes fit).
 * The list is a live query.
 */
export function SprintsView({ sprintId = null, renderDetail, onAction }: SprintsViewProps) {
  const router = useRouter();
  const user = useCurrentUser();
  const admin = user.role === "admin";
  const [creating, setCreating] = useState(false);
  const list = useSprintList();
  const sprints = list.data?.sprints;
  const groups = sprints ? sprintsByRepo(sprints) : [];

  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useSplitWide(splitRef);
  const shownId = sprintId ?? (wide ? (groups[0]?.sprints[0]?.id ?? null) : null);
  const detail = (id: string) =>
    renderDetail ? (
      renderDetail(id)
    ) : (
      <SprintDetailView key={id} sprintId={id} onAction={onAction} />
    );

  const newSprint = admin ? (
    <Button variant="outline" onClick={() => setCreating(true)}>
      {NEW_SPRINT}
    </Button>
  ) : undefined;

  const pane = (
    <div className="or-sprints__pane">
      <div className="or-sprints__head or-split__sticky">
        <h1 className="or-sprints__title">Sprints</h1>
        {admin ? (
          <IconButton icon={IconPlus} label={NEW_SPRINT} onClick={() => setCreating(true)} />
        ) : null}
      </div>
      <div className="or-sprints__list">
        {list.isError && !sprints ? (
          <EmptyState
            headingLevel={2}
            title={SPRINTS_LOAD_FAILED}
            description={list.error.message}
            action={
              <Button variant="outline" onClick={() => void list.refetch()}>
                Try again
              </Button>
            }
          />
        ) : !sprints ? (
          <SprintListSkeleton />
        ) : sprints.length === 0 ? (
          <EmptyState
            headingLevel={2}
            title={NO_SPRINTS}
            description={NO_SPRINTS_DESCRIPTION}
            action={newSprint}
          />
        ) : (
          <div {...rowListProps}>
            {groups.map((group) => (
              <section
                key={group.repository.id}
                className="or-sprints__group"
                aria-labelledby={`sprints-${group.repository.id}`}
              >
                <h2 id={`sprints-${group.repository.id}`} className="or-sprints__group-title">
                  {group.repository.fullPath}
                </h2>
                <RowList aria-label={group.repository.fullPath}>
                  {group.sprints.map((sprint) => {
                    const status = SPRINT_STATUS[sprint.status];
                    return (
                      <ListRow
                        key={sprint.id}
                        href={sprintHref(sprint.id)}
                        kindLabel={status.label}
                        tone={status.tone}
                        title={sprint.name}
                        meta={
                          <>
                            <MetaBadge text={epicCount(sprint.epics.length)} />
                            {sprint.mergeTogether ? <MetaBadge text="Merges together" /> : null}
                          </>
                        }
                        selected={sprint.id === shownId}
                      />
                    );
                  })}
                </RowList>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <SplitView
        ref={splitRef}
        className="or-sprints"
        list={pane}
        detail={shownId ? detail(shownId) : null}
        view={sprintId ? "detail" : "list"}
        backLink={{ label: "Sprints", href: SPRINTS_PATH }}
        listLabel="Sprints"
        detailLabel="Sprint"
      />
      {creating ? (
        <NewSprintSheet
          onClose={() => setCreating(false)}
          onCreated={(id) => router.push(sprintHref(id))}
        />
      ) : null}
    </>
  );
}
