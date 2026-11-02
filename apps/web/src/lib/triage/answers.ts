/**
 * Answers to a triage's open questions sent from Omniralph
 * (`POST /api/ui/runs/{id}/triage/answers`): checked against the run's last result, combined
 * into one reply naming the sender, noted in the triage session, and handed to the run as a
 * reply in its session would be (`replyToTriage`), so the issue is triaged once with them.
 */
import type { TriageRun } from "@omniralph/db";
import { trackerConversation } from "@/lib/ralph/conversation";
import { postActivity } from "@/lib/ralph/notify";
import { previousOutcome, replyToTriage, type TriageReplyOutcome } from "./reply";
import type { TriageDeps } from "./start";

/** An answer to the open question at `index` (from 0), which read `question`. */
export interface TriageQuestionAnswer {
  index: number;
  question: string;
  answer: string;
}

export type AnswerTriageOutcome =
  /** The run's last result left no open questions. */
  | { kind: "no_questions" }
  /** An answer's index isn't one of the open questions. */
  | { kind: "unknown_question" }
  /** An answered question no longer reads as the sender saw it. */
  | { kind: "questions_changed" }
  | TriageReplyOutcome;

/**
 * The one reply the answers make: a header naming `sender`, then each answered question in
 * index order, numbered as the PRD numbers them, with its answer indented below it.
 */
export function composeTriageAnswers(
  answers: readonly TriageQuestionAnswer[],
  sender: string,
): string {
  const blocks = [...answers]
    .sort((a, b) => a.index - b.index)
    .map(({ index, question, answer }) => `${index + 1}. ${question.trim()}\n${indent(answer)}`);
  return [`Answers to the open questions, from Omniralph by ${sender}:`, ...blocks].join("\n\n");
}

/** Every non-blank line of `text` indented under its list item. */
function indent(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `   ${line}` : ""))
    .join("\n");
}

/**
 * Sends `answers` from `sender` to triage run `run`: refused when they don't match the open
 * questions of its last result; otherwise the session gets a note with the combined reply (a
 * failed post is logged and ignored) and the run takes it as a session reply.
 */
export async function answerTriageQuestions(
  deps: TriageDeps,
  run: TriageRun,
  answers: readonly TriageQuestionAnswer[],
  sender: string,
): Promise<AnswerTriageOutcome> {
  const questions = previousOutcome(run)?.openQuestions ?? [];
  if (questions.length === 0) return { kind: "no_questions" };
  if (answers.some((a) => a.index >= questions.length)) return { kind: "unknown_question" };
  if (answers.some((a) => questions[a.index]!.trim() !== a.question.trim())) {
    return { kind: "questions_changed" };
  }
  const text = composeTriageAnswers(answers, sender);
  await postActivity(trackerConversation(deps.tracker, run.trackerSessionId, run.trackerIssueId), {
    type: "thought",
    body: text,
  });
  return replyToTriage(deps, run, text);
}
