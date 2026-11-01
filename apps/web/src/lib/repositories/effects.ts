/**
 * What saving a repo setting will do: each function turns one field change into a save bar
 * item `{ id, label, from, to, effect }` with the effect sentence the Repos screen shows
 * (PRD "Pending-change effects"). Pull request or merge request follows the provider. Pure,
 * so every card (and Settings) words its changes the same way. Safe to import in the
 * browser.
 */
import {
  REVIEW_DEPTH_IDS,
  REVIEW_DEPTHS,
  type RalphHistoryRewrite,
  type ReviewDepth,
} from "@omniralph/shared";
import { trackerLabel } from "@/lib/api/trackers";
import type { WORK_ITEM_TRACKERS } from "@/lib/api/work-item-matches";

/** A tracker a work item match can name. */
type WorkItemMatchTracker = (typeof WORK_ITEM_TRACKERS)[number];

export type CodeHost = "github" | "gitlab";

/** One pending change of a card, as its save bar lists it. */
export interface FieldEffect {
  /** Unique within the card: the field (and value, for list items). */
  id: string;
  label: string;
  /** The saved value; left out where it would be noise (long text, a list item added). */
  from?: string;
  /** The value after saving; left out like `from`. */
  to?: string;
  /** One sentence: what saving it will do. */
  effect: string;
}

/** "pull request" on GitHub, "merge request" on GitLab. */
export function requestNoun(provider: CodeHost): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** "PR" on GitHub, "MR" on GitLab. */
export function requestAbbreviation(provider: CodeHost): string {
  return provider === "gitlab" ? "MR" : "PR";
}

const onOff = (value: boolean) => (value ? "On" : "Off");

/** A switch or checkbox: its label, on/off values and the sentence for its new state. */
function toggle(
  id: string,
  label: string,
  to: boolean,
  sentences: { on: string; off: string },
): FieldEffect {
  return { id, label, from: onOff(!to), to: onOff(to), effect: to ? sentences.on : sentences.off };
}

// ── Reviews ──────────────────────────────────────────────────────────────────────────────

/** The Reviews switch. */
export function reviewsEnabledEffect(provider: CodeHost, to: boolean): FieldEffect {
  const requests = `${requestNoun(provider)}s`;
  return toggle("reviewsEnabled", "Reviews", to, {
    on: `New ${requests} will be reviewed.`,
    off: `New ${requests} won't be reviewed.`,
  });
}

/** "Review when: PR opened" (MR on GitLab). */
export function reviewOnOpenEffect(provider: CodeHost, to: boolean): FieldEffect {
  const request = requestNoun(provider);
  return toggle("onOpen", `${requestAbbreviation(provider)} opened`, to, {
    on: `Opening a ${request} starts a review.`,
    off: `Opening a ${request} won't start a review.`,
  });
}

/** "Review when: New commits pushed". */
export function reviewOnPushEffect(provider: CodeHost, to: boolean): FieldEffect {
  const request = requestNoun(provider);
  return toggle("onPush", "New commits pushed", to, {
    on: `Pushing to an open ${request} starts a review.`,
    off: `Pushing to an open ${request} won't start a review.`,
  });
}

/** "Review when: Drafts too". */
export function reviewDraftsEffect(provider: CodeHost, to: boolean): FieldEffect {
  const request = requestNoun(provider);
  return toggle("drafts", "Drafts too", to, {
    on: `Draft ${request}s are reviewed too.`,
    off: `Draft ${request}s aren't reviewed.`,
  });
}

/**
 * How many times longer a review at `to` takes than at `from`: each step deeper doubles the
 * typical time (`REVIEW_DEPTHS`: Deep is about 2× Standard, and Quick → Standard counts as
 * 2× by the same rule).
 */
export function depthTimeFactor(from: ReviewDepth, to: ReviewDepth): number {
  return 2 ** (REVIEW_DEPTH_IDS.indexOf(to) - REVIEW_DEPTH_IDS.indexOf(from));
}

/** The Depth control. */
export function reviewDepthEffect(from: ReviewDepth, to: ReviewDepth): FieldEffect {
  const factor = depthTimeFactor(from, to);
  return {
    id: "depth",
    label: "Depth",
    from: REVIEW_DEPTHS[from].label,
    to: REVIEW_DEPTHS[to].label,
    effect:
      factor > 1
        ? `New reviews will take about ${factor}× longer and use more tokens.`
        : "New reviews will be faster, use fewer tokens and read less of the repo.",
  };
}

/** Skip paths: one item per glob added or removed, in that order. */
export function skipPathEffects(from: readonly string[], to: readonly string[]): FieldEffect[] {
  const added = to.filter((glob) => !from.includes(glob));
  const removed = from.filter((glob) => !to.includes(glob));
  return [
    ...added.map((glob) => ({
      id: `pathExcludes:+${glob}`,
      label: "Skip path added",
      to: glob,
      effect: `Reviews skip files matching ${glob}.`,
    })),
    ...removed.map((glob) => ({
      id: `pathExcludes:-${glob}`,
      label: "Skip path removed",
      from: glob,
      effect: `Reviews read files matching ${glob} again.`,
    })),
  ];
}

/** Reviewer instructions (the text itself is too long to list). */
export function reviewerInstructionsEffect(): FieldEffect {
  return {
    id: "reviewerInstructions",
    label: "Reviewer instructions edited",
    effect: "Applies to new reviews.",
  };
}

// ── Coding ───────────────────────────────────────────────────────────────────────────────

/** A work item match's conditions, as the Coding card shows them. */
export interface WorkItemMatchConditions {
  tracker: WorkItemMatchTracker;
  team: string;
  project: string | null;
  withoutProject: boolean;
  labels: readonly string[];
}

/**
 * A match as one sentence, the badge sentence's words, led by the tracker's name: "<tracker> team
 * SOC in project Portal and label bug or ui" ("with no project" for work items without one).
 */
export function workItemMatchText(match: WorkItemMatchConditions): string {
  let text = `${trackerLabel(match.tracker)} team ${match.team}`;
  if (match.withoutProject) text += " with no project";
  else if (match.project !== null) text += ` in project ${match.project}`;
  if (match.labels.length > 0) text += ` and label ${match.labels.join(" or ")}`;
  return text;
}

/** The Coding switch. */
export function codingEnabledEffect(to: boolean): FieldEffect {
  return toggle("codingEnabled", "Coding", to, {
    on: "Om starts building work items that match.",
    off: "Om stops picking up new work items for this repo. Runs already started finish.",
  });
}

/**
 * The work item match, by its sentence (null for none). Each conflicting repo adds "Om will
 * ask between this repo and <repo>."
 */
export function workItemMatchEffect(
  from: string | null,
  to: string | null,
  conflicts: readonly string[] = [],
): FieldEffect {
  const asks = conflicts.map((repo) => ` Om will ask between this repo and ${repo}.`).join("");
  const base = { id: "workItemMatch" } as const;
  if (to === null) {
    return {
      ...base,
      label: "Work item match removed",
      ...(from === null ? {} : { from }),
      effect: "No work items route here by match.",
    };
  }
  if (from === null) {
    return {
      ...base,
      label: "Work item match added",
      to,
      effect: `Work items matching ${to} route here.${asks}`,
    };
  }
  return {
    ...base,
    label: "Work item match changed",
    from,
    to,
    effect: `Work items matching ${to} route here instead of ${from}.${asks}`,
  };
}

/** Extra instructions (the text itself is too long to list). */
export function codingInstructionsEffect(): FieldEffect {
  return {
    id: "codingInstructions",
    label: "Extra instructions edited",
    effect: "Applies to new stories.",
  };
}

const checkCount = (count: number) =>
  count === 0 ? "None" : count === 1 ? "1 check" : `${count} checks`;

/** The Checks list: added, edited, removed or reordered commands. */
export function checksEffect(from: readonly string[], to: readonly string[]): FieldEffect {
  return {
    id: "checks",
    label: "Checks",
    from: checkCount(from.length),
    to: checkCount(to.length),
    effect:
      to.length === 0
        ? "New stories and requests run no repo checks."
        : "New stories and requests run these checks, in order, after their changes.",
  };
}

/** "Open a draft PR after the first story" (MR on GitLab). */
export function openPullRequestEarlyEffect(provider: CodeHost, to: boolean): FieldEffect {
  const request = requestNoun(provider);
  return toggle(
    "openPullRequestEarly",
    `Open a draft ${requestAbbreviation(provider)} after the first story`,
    to,
    {
      on: `Om opens a draft ${request} after the first story.`,
      off: `Om opens the ${request} when every story is done.`,
    },
  );
}

/** "Fix review comments and CI failures (up to N rounds each)". */
export function respondToReviewsAndCiEffect(
  provider: CodeHost,
  to: boolean,
  rounds: number,
): FieldEffect {
  return toggle(
    "respondToReviewsAndCi",
    `Fix review comments and CI failures (up to ${rounds} rounds each)`,
    to,
    {
      on: `Om fixes review comments and CI failures on its ${requestNoun(provider)}s, up to ${rounds} rounds each.`,
      off: "Om leaves review comments and CI failures to you.",
    },
  );
}

/** Rewrite history's choices, as the control labels them. */
export const HISTORY_REWRITE_LABELS: Readonly<Record<RalphHistoryRewrite, string>> = {
  "when-asked": "When asked",
  always: "Always",
  never: "Never",
};

const HISTORY_REWRITE_EFFECTS: Readonly<Record<RalphHistoryRewrite, string>> = {
  "when-asked": "Om rebases and force-pushes only when a request asks for it.",
  always: "Om rebases instead of merging the base branch, and force-pushes its branch.",
  never: "Om never force-pushes; it merges the base branch instead.",
};

/** The Rewrite history control. */
export function historyRewriteEffect(
  from: RalphHistoryRewrite,
  to: RalphHistoryRewrite,
): FieldEffect {
  return {
    id: "historyRewrite",
    label: "Rewrite history",
    from: HISTORY_REWRITE_LABELS[from],
    to: HISTORY_REWRITE_LABELS[to],
    effect: HISTORY_REWRITE_EFFECTS[to],
  };
}

// ── Ask, Agents, Playbooks ───────────────────────────────────────────────────────────────

/** The Ask switch. */
export function askEnabledEffect(to: boolean): FieldEffect {
  return toggle("askEnabled", "Ask", to, {
    on: "Om answers questions about this repo's code.",
    off: "Om won't answer questions about this repo's code.",
  });
}

/** An agent pinned. */
export function agentPinnedEffect(agent: { id: string; name: string }): FieldEffect {
  return {
    id: `pin:${agent.id}`,
    label: "Agent pinned",
    to: agent.name,
    effect: "Work for this repo runs only on pinned agents.",
  };
}

/** An agent unpinned; `last` when no agent stays pinned. */
export function agentUnpinnedEffect(
  agent: { id: string; name: string },
  last: boolean,
): FieldEffect {
  return {
    id: `unpin:${agent.id}`,
    label: "Agent unpinned",
    from: agent.name,
    effect: last
      ? "Any agent can take this repo's work."
      : `${agent.name} no longer takes this repo's work.`,
  };
}

/** A playbook binding, e.g. role "review" or "story" (`label` is the binding's field label). */
export function playbookBindingEffect(
  binding: string,
  label: string,
  role: string,
  from: string,
  to: string,
): FieldEffect {
  return { id: `playbook:${binding}`, label, from, to, effect: `New ${role} runs use ${to}.` };
}
