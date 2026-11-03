/**
 * A triage run's rounds as its run page shows them (`RunIterationView.triage`): each round's
 * record (`run_iterations.details`, a `TriageRound`) with the changes its draft made to the
 * previous round's.
 */
import type { RunIteration } from "@omniralph/db";
import { TriageRound, type TriageRoundDraft } from "@omniralph/shared";
import type { TriageRoundView } from "@/lib/api/runs";
import { lineDiff } from "./line-diff";

const SIZE_WORDS: Record<TriageRoundDraft["sizing"]["size"], string> = {
  fix: "Fix",
  story: "Story",
  epic: "Epic",
  feature: "Feature",
};

/** A draft as the text its round's changes compare: title, sizing, description, stories, questions. */
export function draftText(draft: TriageRoundDraft): string {
  const parts = [
    `# ${draft.title}`,
    `Size: ${SIZE_WORDS[draft.sizing.size]} (${draft.size}). ${draft.sizing.reason}`,
    draft.description.trim(),
    ...draft.stories.map(
      (story, index) => `## Story ${index + 1}: ${story.title}\n\n${story.body.trim()}`,
    ),
  ];
  if (draft.openQuestions.length > 0) {
    parts.push(["## Open questions", ...draft.openQuestions.map((q) => `- ${q}`)].join("\n"));
  }
  return parts.join("\n\n");
}

/** A round's record, or null for an iteration without one (its checks haven't run yet). */
const roundOf = (iteration: Pick<RunIteration, "details">): TriageRound | null => {
  const parsed = TriageRound.safeParse(iteration.details);
  return parsed.success ? parsed.data : null;
};

/**
 * The run page's view of each iteration of a triage run (first first, as given): null for one
 * without a round record yet. A round's changes compare its draft with the last earlier
 * round's usable draft.
 */
export function triageRoundViews(
  iterations: readonly Pick<RunIteration, "details">[],
): (TriageRoundView | null)[] {
  let previous: string | null = null;
  return iterations.map((iteration) => {
    const round = roundOf(iteration);
    if (!round) return null;
    let changes: TriageRoundView["changes"] = null;
    if (round.draft) {
      const text = draftText(round.draft);
      changes = previous === null ? null : lineDiff(previous, text);
      previous = text;
    }
    return {
      sizing: round.draft ? round.draft.sizing : null,
      title: round.draft?.title ?? null,
      lint: round.lint,
      critique: round.critique,
      changes,
    };
  });
}
