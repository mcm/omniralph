/**
 * Why a run waits on a person, stopped or failed, as one plain-language sentence: the Inbox
 * item's `reason` and the run detail's (`GET /api/ui/runs/{id}`) come from `runReason`, so
 * both say the same thing.
 */
import type { InboxQuestionKind, RunKind } from "@omniralph/db";
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

/** The reason sentence for `facts`. */
export function runReason(facts: RunReasonFacts): string {
  switch (facts.kind) {
    case "manual_story":
      return facts.elsewhere
        ? `${facts.identifier} routes to a repo with coding off, so a person has to do it.`
        : `${facts.identifier} is a manual story: a person has to do it before the epic goes on.`;
    case "blocked_epic": {
      const names = facts.blockers.join(", ");
      return facts.blockers.length === 1
        ? `Waiting on ${names}, which is outside the epic.`
        : `Waiting on ${names}, which are outside the epic.`;
    }
    case "question":
      return questionReason(facts);
    case "stopped":
      return withError(`The ${KIND_NAMES[facts.runKind]} was stopped.`, facts.error);
    case "failed":
      return withError("The run failed.", facts.error);
  }
}
