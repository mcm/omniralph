"use client";

import {
  Button,
  Card,
  EmptyState,
  Field,
  SaveBar,
  Select,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { useMemo } from "react";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { api } from "@/lib/api/client";
import { connectionKeys } from "@/lib/api/keys";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";
import { trackerStateMappingSchema, type TrackerStateMappingView } from "@/lib/api/trackers";
import { useTrackerStateMapping } from "./queries";

/** The card's help line. */
export const WORK_ITEM_STATES_HELP = "Backlog groups work items by these states.";

/** Shown when both choices are the same state. */
export const SAME_STATE_ERROR = "A state can't be both Ready to start and Needs refining.";

/** Each state type's name when the workspace has no state of it (Linear's defaults). */
const TYPE_NAMES: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In Progress",
};

/** The card's two choices: each a readiness's state types, joined by commas. */
export interface WorkItemStatesDraft {
  ready: string;
  needsRefining: string;
}

export interface StateOption {
  value: string;
  label: string;
}

const typesOf = (value: string) => value.split(",").filter(Boolean);

/**
 * Each state type's name in the workspace: the names of its workflow states of that type,
 * across its teams ("Todo", or "Todo / Ready" when teams differ), else Linear's default.
 */
function typeNames(view: TrackerStateMappingView): Map<string, string> {
  const names = new Map<string, string[]>();
  for (const team of view.teams) {
    for (const state of team.states) {
      const list = names.get(state.type) ?? [];
      if (!list.includes(state.name)) list.push(state.name);
      names.set(state.type, list);
    }
  }
  return new Map(
    view.stateTypes.map((type) => [type, names.get(type)?.join(" / ") ?? TYPE_NAMES[type] ?? type]),
  );
}

/**
 * The choices of each select: one per state type a readiness may use that the workspace has
 * (named by its states), plus the saved choices themselves, so a mapping of several types
 * (saved through the API) still shows as it is.
 */
export function stateOptions(view: TrackerStateMappingView): StateOption[] {
  const names = typeNames(view);
  const present = new Set(view.teams.flatMap((team) => team.states.map((state) => state.type)));
  const label = (value: string) =>
    typesOf(value)
      .map((type) => names.get(type) ?? TYPE_NAMES[type] ?? type)
      .join(", ");
  const values = view.stateTypes.filter((type) => present.has(type)) as string[];
  for (const saved of [view.mapping.ready.types, view.mapping.needsRefining.types]) {
    const value = saved.join(",");
    if (value && !values.includes(value)) values.push(value);
  }
  return values.map((value) => ({ value, label: label(value) }));
}

/** Whether the two choices share a state type. */
export function statesOverlap(draft: WorkItemStatesDraft): boolean {
  const ready = new Set(typesOf(draft.ready));
  return typesOf(draft.needsRefining).some((type) => ready.has(type));
}

function changesFor(options: readonly StateOption[]) {
  const label = (value: string) => options.find((option) => option.value === value)?.label ?? value;
  return (saved: WorkItemStatesDraft, draft: WorkItemStatesDraft): StagedChange[] => {
    const changes: StagedChange[] = [];
    if (draft.ready !== saved.ready) {
      changes.push({
        id: "ready",
        label: "Ready to start",
        from: label(saved.ready),
        to: label(draft.ready),
      });
    }
    if (draft.needsRefining !== saved.needsRefining) {
      changes.push({
        id: "needsRefining",
        label: "Needs refining",
        from: label(saved.needsRefining),
        to: label(draft.needsRefining),
      });
    }
    return changes;
  };
}

function StatesForm({
  view,
  isAdmin,
  history,
}: {
  view: TrackerStateMappingView;
  isAdmin: boolean;
  history: SettingsHistoryEntry | null;
}) {
  const options = useMemo(() => stateOptions(view), [view]);
  const saved = useMemo<WorkItemStatesDraft>(
    () => ({
      ready: view.mapping.ready.types.join(","),
      needsRefining: view.mapping.needsRefining.types.join(","),
    }),
    [view.mapping],
  );
  const toChanges = useMemo(() => changesFor(options), [options]);
  const card = useStagedCard<WorkItemStatesDraft, TrackerStateMappingView>({
    label: "Work item states",
    saved,
    toChanges,
    conflictMessage: "Another admin changed these states while you were editing.",
    save: useStagedSave({
      request: (draft, { organizationId }) =>
        api.put(
          `/api/ui/trackers/${encodeURIComponent(view.integrationId)}/state-mapping`,
          trackerStateMappingSchema,
          {
            body: {
              ready: { types: typesOf(draft.ready) },
              needsRefining: { types: typesOf(draft.needsRefining) },
              // Per-team overrides, set through the API, stay as they are.
              teams: view.mapping.teams,
            },
            organizationId,
          },
        ),
      applyResult: (result, cache) =>
        cache.set<TrackerStateMappingView>(
          connectionKeys(cache.keys).stateMapping(view.integrationId),
          () => result,
          { exact: true },
        ),
    }),
    onDirtyChange: useUnsavedCard("Work item states", "work-item-states"),
  });
  const overlap = statesOverlap(card.draft);
  const readyError = card.fieldErrors["ready.types"];
  const refiningError = overlap ? SAME_STATE_ERROR : card.fieldErrors["needsRefining.types"];

  const select = (field: keyof WorkItemStatesDraft, id: string, error: string | undefined) => (
    <Select
      id={id}
      value={card.draft[field]}
      disabled={!isAdmin || card.saving}
      errorMessage={error}
      onChange={(event) => card.set(field, event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );

  return (
    <Card
      title="Work item states"
      titleId="work-item-states"
      titleAddon={
        <ChangeHistoryPopover section="connection" subject={view.integrationId} latest={history} />
      }
    >
      <p className="or-connection__note">{WORK_ITEM_STATES_HELP}</p>
      <div className="or-connection__states">
        <Field label="Ready to start" htmlFor="work-item-states-ready" stacked>
          {select("ready", "work-item-states-ready", readyError)}
        </Field>
        <Field label="Needs refining" htmlFor="work-item-states-needs-refining" stacked>
          {select("needsRefining", "work-item-states-needs-refining", refiningError)}
        </Field>
      </div>
      {isAdmin ? (
        <SaveBar
          changes={card.changes}
          onSave={() => {
            // The two must differ: the error shows under Needs refining, nothing is sent.
            if (!overlap) card.submit();
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
 * The Linear connection's "Work item states" card: which of the workspace's workflow states
 * mean "Ready to start" and "Needs refining" (by default Todo and Backlog), which group the
 * Backlog. Admins stage both choices and save them in one `PUT …/state-mapping`, written into
 * the cache from the answer; members see them read-only. A live query: another admin's save
 * arrives through the connection's `connection` event.
 */
export function WorkItemStatesCard({
  integrationId,
  isAdmin,
  history,
}: {
  integrationId: string;
  isAdmin: boolean;
  history: SettingsHistoryEntry | null;
}) {
  const query = useTrackerStateMapping(integrationId);
  if (query.isPending) {
    return (
      <Card title="Work item states" titleId="work-item-states">
        <p aria-busy="true">Loading…</p>
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card title="Work item states" titleId="work-item-states">
        <EmptyState
          headingLevel={3}
          title="Couldn't load the workflow states"
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
  return <StatesForm view={query.data} isAdmin={isAdmin} history={history} />;
}
