import type { StatusTone } from "@omniralph/ui";
import type { SprintRow, SprintStatusValue } from "@/lib/api/sprints";

/** Where the Sprints screen lives, and one sprint's page. */
export const SPRINTS_PATH = "/sprints";
export const sprintHref = (sprintId: string) => `${SPRINTS_PATH}/${encodeURIComponent(sprintId)}`;

/** A sprint status's label and tone (Design rule 15). */
export const SPRINT_STATUS: Record<SprintStatusValue, { label: string; tone: StatusTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  running: { label: "Running", tone: "run" },
  paused: { label: "Paused", tone: "warn" },
  done: { label: "Done", tone: "good" },
  canceled: { label: "Canceled", tone: "neutral" },
};

/** What a person can do to a sprint once it's built. */
export type SprintAction = "start" | "pause" | "resume" | "cancel";

export const SPRINT_ACTION_LABELS: Record<SprintAction, string> = {
  start: "Start sprint",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel sprint",
};

/**
 * The actions each status allows, in button order, and one line on what they do. A draft
 * starts; a running sprint pauses or cancels; a paused one resumes or cancels; a done or
 * canceled sprint is over.
 */
export const SPRINT_ACTIONS: Record<
  SprintStatusValue,
  { actions: readonly SprintAction[]; explanation: string | null }
> = {
  draft: {
    actions: ["start"],
    explanation:
      "Starting runs the first epic; Om starts each next one when the one before merges.",
  },
  running: {
    actions: ["pause", "cancel"],
    explanation:
      "Pausing lets the running epic finish but starts no new one; canceling ends the sprint.",
  },
  paused: {
    actions: ["resume", "cancel"],
    explanation: "Resuming starts the next queued epic; canceling ends the sprint.",
  },
  done: { actions: [], explanation: null },
  canceled: { actions: [], explanation: null },
};

/** "1 epic", "3 epics". */
export function epicCount(count: number): string {
  return count === 1 ? "1 epic" : `${count} epics`;
}

/** The sprints grouped by repo, repos by path, each repo's sprints in the list's order. */
export function sprintsByRepo(
  sprints: readonly SprintRow[],
): { repository: SprintRow["repository"]; sprints: SprintRow[] }[] {
  const groups = new Map<string, { repository: SprintRow["repository"]; sprints: SprintRow[] }>();
  for (const sprint of sprints) {
    const group = groups.get(sprint.repository.id) ?? {
      repository: sprint.repository,
      sprints: [],
    };
    group.sprints.push(sprint);
    groups.set(sprint.repository.id, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.repository.fullPath.localeCompare(b.repository.fullPath),
  );
}
