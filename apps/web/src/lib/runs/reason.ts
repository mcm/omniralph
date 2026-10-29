/**
 * Why a run waits on a person or an agent, stopped or failed, as one plain-language sentence
 * (and, for some, a link to where it's fixed): the Inbox item's `reason` and `reasonLink` and
 * the run detail's (`GET /api/ui/runs/{id}`) come from `runReason` and `runReasonLink`, so
 * both say the same thing.
 */
import type { InboxQuestionKind, JobWaitingReason, RunKind } from "@omniralph/db";
import type { ReasonLink } from "@/lib/api/runs";
import { truncate } from "@/lib/ralph/display";

/** Longest error a reason quotes. */
const REASON_ERROR_MAX_LENGTH = 300;

/** What a reason is built from. */
export type RunReasonFacts =
  | {
      kind: "manual_story";
      identifier: string;
      /** It routes to a repo with coding off (not labelled manual). */
      elsewhere: boolean;
    }
  | { kind: "blocked_epic"; blockers: readonly string[] }
  | {
      kind: "question";
      question: InboxQuestionKind;
      /** A preparation question's manual story. */
      story: string | null;
      /** A permission's tool. */
      tool: string | null;
      /** A cleanup question's PR/MR, as `changeRequestName` names it. */
      pullRequest: string;
    }
  /** A queued run whose newest attempt needs host tools no online agent has. */
  | { kind: "host_tools_missing"; hostTools: readonly string[] }
  | { kind: "stopped"; runKind: RunKind; error: string | null }
  | { kind: "failed"; error: string | null };

/** "pull request #42" on GitHub, "merge request !7" on GitLab. */
export function changeRequestName(
  provider: "github" | "gitlab" | undefined,
  number: number,
): string {
  return provider === "gitlab" ? `merge request !${number}` : `pull request #${number}`;
}

/** A sentence ending in the error, when there is one. */
export function withError(sentence: string, error: string | null): string {
  const message = error?.trim().replace(/\s+/g, " ");
  return message ? `${sentence} ${truncate(message, REASON_ERROR_MAX_LENGTH)}` : sentence;
}

const KIND_NAMES: Record<RunKind, string> = {
  epic: "epic",
  request: "request",
  review: "review",
  triage: "triage",
  ask: "ask",
};

function questionReason(facts: Extract<RunReasonFacts, { kind: "question" }>): string {
  switch (facts.question) {
    case "repository":
      return "Om needs to know which repo to work in.";
    case "preparation":
      return `Om asks whether to run the preparation of ${facts.story ?? "a manual story"}.`;
    case "cleanup":
      return `Om asks what to do with what's left of the merged ${facts.pullRequest}.`;
    case "permission":
      return facts.tool ? `Om asks to use ${facts.tool}.` : "Om asks to use a tool.";
  }
}

/** "a", "a and b", "a, b and c". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The reason facts of a queued run's newest attempt's waiting reason (null: none). */
export function waitingReasonFacts(
  reason: JobWaitingReason | null | undefined,
): Extract<RunReasonFacts, { kind: "host_tools_missing" }> | null {
  return reason?.code === "host_tools_missing" && reason.hostTools.length > 0
    ? { kind: "host_tools_missing", hostTools: reason.hostTools }
    : null;
}

/** Where a reason's problem is fixed, shown after its sentence; null for most reasons. */
export function runReasonLink(facts: RunReasonFacts): ReasonLink | null {
  return facts.kind === "host_tools_missing" ? { label: "Open Fleet", href: "/fleet" } : null;
}

/** The reason sentence for `facts`. */
export function runReason(facts: RunReasonFacts): string {
  switch (facts.kind) {
    case "manual_story":
      return facts.elsewhere
        ? `${facts.identifier} routes to a repo with coding off, so a person has to do it.`
        : `${facts.identifier} is a manual story: a person has to do it before the epic can finish.`;
    case "blocked_epic": {
      const names = facts.blockers.join(", ");
      return facts.blockers.length === 1
        ? `Waiting on ${names}, which is outside the epic.`
        : `Waiting on ${names}, which are outside the epic.`;
    }
    case "question":
      return questionReason(facts);
    case "host_tools_missing":
      return `Waiting for an agent with ${listOf([...facts.hostTools].sort())} installed`;
    case "stopped":
      return withError(`The ${KIND_NAMES[facts.runKind]} was stopped.`, facts.error);
    case "failed":
      return withError("The run failed.", facts.error);
  }
}
