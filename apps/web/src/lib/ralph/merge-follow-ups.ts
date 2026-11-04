/**
 * Follow-ups that ask to merge another branch into a run's branch. Epics ship
 * independently, each through its own PR/MR to the default branch, so a run's
 * branch never takes in another branch's history: `fileFollowUps` drops these
 * instead of filing them, whatever the agent returns.
 */
import type { RalphFollowUp } from "@omniralph/shared";

/** Names for a run's branch that don't spell it out. */
const BRANCH_NAMES = /\b(?:this|the feature|the epic) branch\b/i;

/** "merge … into", in one sentence. */
const MERGE_INTO = /\bmerg(?:e|es|ed|ing)\b[\s\S]*\binto\b/i;

/**
 * Splits text into sentences: at a sentence-ending mark followed by a space
 * or the end, or at a line break, so a dot inside a branch name (`v1.2`)
 * doesn't split it.
 */
function sentences(text: string): string[] {
  return text.split(/[.!?;](?=\s|$)|\n+/);
}

/**
 * Whether `text` asks for a merge into the run's branch: one of its sentences
 * says merge … into and names `branch` (the lane's branch), "this branch",
 * "the feature branch" or "the epic branch". Merging in another sense ("merge
 * duplicate config keys into one file") doesn't count.
 */
export function asksForBranchMerge(text: string, branch: string | null | undefined): boolean {
  const name = branch?.trim().toLowerCase();
  return sentences(text).some((sentence) => {
    if (!MERGE_INTO.test(sentence)) return false;
    return BRANCH_NAMES.test(sentence) || (!!name && sentence.toLowerCase().includes(name));
  });
}

/** Whether a follow-up's title or description asks for a merge into the run's branch. */
export function isBranchMergeFollowUp(
  followUp: Pick<RalphFollowUp, "title" | "description">,
  branch: string | null | undefined,
): boolean {
  return (
    asksForBranchMerge(followUp.title, branch) || asksForBranchMerge(followUp.description, branch)
  );
}
