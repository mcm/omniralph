/**
 * The rounds of a triage loop, without the database: what a round's draft is
 * as its record keeps it, what the work item lint finds in it, the verdict its
 * two checks (the lint and the plan critic) give, the feedback the next round
 * revises with, and the open questions what still fails becomes at the cap.
 */
import { lintWorkItem } from "@omniralph/planning";
import type { TriageResult } from "@omniralph/ralph";
import {
  PlanCritiqueOutput,
  QueryRunResult,
  TriageRound,
  type PlanCritiqueRequest,
  type TriageRoundCritique,
  type TriageRoundDraft,
  type TriageRoundLint,
} from "@omniralph/shared";

/** Most open questions a triage keeps (`TriageOutcome.openQuestions`). */
const MAX_OPEN_QUESTIONS = 50;
/** Longest open question a triage keeps. */
const MAX_QUESTION_LENGTH = 4000;

/** A validated triage as its round's record keeps it. */
export function roundDraft(triage: TriageResult): TriageRoundDraft {
  return {
    outcome: triage.outcome,
    sizing: triage.sizing,
    size: triage.size,
    title: triage.title,
    description: triage.description,
    openQuestions: [...triage.openQuestions],
    stories: draftStories(triage),
  };
}

/**
 * A draft's stories with their order: a new epic's stories as planned, or a reformat's sub-issue
 * updates, each blocked by the updated siblings its `blockedBy` names (blockers outside the
 * epic aren't stories of the draft). A sub-issue update has no kind or manual flag of its own.
 */
function draftStories(triage: TriageResult): TriageRoundDraft["stories"] {
  if (triage.outcome === "prd") {
    return triage.stories.map((s) => ({
      title: s.title,
      body: s.body,
      kind: s.kind,
      dependsOn: [...s.dependsOn],
      manual: s.manual,
    }));
  }
  if (triage.outcome !== "reformat") return [];
  const indexOf = new Map(triage.subIssueUpdates.map((u, index) => [u.id, index]));
  return triage.subIssueUpdates.map((u) => ({
    title: u.title,
    body: u.body,
    kind: "story",
    dependsOn: u.blockedBy.flatMap((id) => {
      const index = indexOf.get(id);
      return index === undefined ? [] : [index];
    }),
    manual: false,
  }));
}

/**
 * The work item lint of a draft: its description in the format its size calls for (an epic for
 * an Epic, else a task), then each story's body as a task. A Feature's recommendation isn't a
 * work item, so nothing is linted.
 */
export function lintDraft(draft: TriageRoundDraft): TriageRoundLint {
  if (draft.sizing.size === "feature") return { passed: true, problems: [] };
  const problems = lintWorkItem(draft.description, {
    format: draft.sizing.size === "epic" ? "epic" : "task",
  }).map((p) => p.message);
  draft.stories.forEach((story, index) => {
    for (const p of lintWorkItem(story.body, { format: "task" })) {
      problems.push(`Story ${index + 1} ("${story.title}"): ${p.message}`);
    }
  });
  return { passed: problems.length === 0, problems };
}

/** A round whose worker reported no usable triage: `problem` is its lint failure. */
export function unusableRound(problem: string): TriageRound {
  return { draft: null, lint: { passed: false, problems: [problem] }, critique: null };
}

/** The first round of a draft: its lint, before (or without) the critic. */
export function draftRound(triage: TriageResult): TriageRound {
  const draft = roundDraft(triage);
  return { draft, lint: lintDraft(draft), critique: null };
}

/** Whether the plan critic judges the round's draft: a usable one that isn't a Feature. */
export function needsCritique(
  round: TriageRound,
): round is TriageRound & { draft: TriageRoundDraft } {
  return round.draft !== null && round.draft.sizing.size !== "feature";
}

/** The draft as the plan critic is asked to judge it. */
export function critiqueRequest(draft: TriageRoundDraft): PlanCritiqueRequest {
  const size = draft.sizing.size;
  if (size === "feature") throw new Error("A Feature's recommendation isn't critiqued");
  return {
    size,
    title: draft.title,
    description: draft.description,
    stories: draft.stories.map((s) => ({
      title: s.title,
      body: s.body,
      kind: s.kind,
      dependsOn: [...s.dependsOn],
      manual: s.manual,
    })),
  };
}

/** The critic's answer in its job's result; null when it didn't answer with a critique. */
export function readCritique(result: unknown): TriageRoundCritique | null {
  const run = QueryRunResult.safeParse(result);
  if (!run.success || run.data.outcome !== "answered") return null;
  const output = PlanCritiqueOutput.safeParse(run.data.structured);
  if (!output.success) return null;
  return {
    verdict: output.data.verdict,
    notes: output.data.notes,
    openQuestions: output.data.openQuestions,
  };
}

/** A round's record from an iteration's `details`; null when it holds none. */
export function readRound(details: unknown): TriageRound | null {
  const round = TriageRound.safeParse(details);
  return round.success ? round.data : null;
}

/**
 * Whether the round passed both checks: the lint passed and the critic passed the draft (or
 * had nothing to judge: a Feature's recommendation).
 */
export function roundPassed(round: TriageRound): boolean {
  if (!round.lint.passed || round.draft === null) return false;
  return needsCritique(round) ? round.critique?.verdict === "pass" : true;
}

/** What the round's checks found, one point each: lint failures, unmet rubric items, questions. */
export function roundFindings(round: TriageRound): string[] {
  const critique = round.critique;
  return [
    ...round.lint.problems.map((p) => `Lint: ${p}`),
    ...(critique?.notes ?? []).filter((n) => !n.ok).map((n) => `Critic (${n.item}): ${n.note}`),
    ...(critique?.openQuestions ?? []).map((q) => `Critic's open question: ${q}`),
  ];
}

/** The round's verdict summary: how each check went. */
export function roundSummary(round: TriageRound): string {
  if (round.draft === null)
    return "The draft wasn't a usable triage, so the critic didn't judge it.";
  const lint = round.lint.passed
    ? "The lint passed"
    : `The lint found ${round.lint.problems.length} ${round.lint.problems.length === 1 ? "problem" : "problems"}`;
  if (!needsCritique(round)) return `${lint}; a Feature's recommendation isn't critiqued.`;
  const critique = round.critique;
  if (!critique) return `${lint}; the critic hasn't judged it.`;
  const unmet = critique.notes.filter((n) => !n.ok).length;
  const questions = critique.openQuestions.length;
  const verdict =
    critique.verdict === "pass"
      ? "the critic passed it"
      : `the critic failed it (${unmet} unmet ${unmet === 1 ? "item" : "items"}, ${questions} open ${questions === 1 ? "question" : "questions"})`;
  return `${lint}; ${verdict}.`;
}

/**
 * The open questions what still fails in `round` becomes when the loop stops without a pass
 * (`rounds` rounds in): each lint failure, each unmet rubric item and each of the critic's own
 * questions, so a person settles them before the work item starts.
 */
export function unresolvedQuestions(round: TriageRound, rounds: number): string[] {
  const after = `Triage couldn't settle this in ${rounds} ${rounds === 1 ? "round" : "rounds"}`;
  const critique = round.critique;
  return [
    ...round.lint.problems.map(
      (p) => `The work item lint still fails: ${p} ${after}: what should the plan say?`,
    ),
    ...(critique?.notes ?? [])
      .filter((n) => !n.ok)
      .map(
        (n) =>
          `The plan critic found "${n.item}" unmet: ${n.note} ${after}: how should the plan address it?`,
      ),
    ...(critique?.openQuestions ?? []),
  ];
}

/** `questions` after `existing`, without repeats, within what a triage keeps. */
export function withQuestions(existing: readonly string[], questions: readonly string[]): string[] {
  const all = [...existing];
  const seen = new Set(existing.map((q) => q.trim().toLowerCase()));
  for (const question of questions) {
    const text =
      question.length > MAX_QUESTION_LENGTH
        ? `${question.slice(0, MAX_QUESTION_LENGTH - 1)}…`
        : question;
    const key = text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    all.push(text);
  }
  return all.slice(0, MAX_OPEN_QUESTIONS);
}
