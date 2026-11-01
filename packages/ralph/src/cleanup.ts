/**
 * Questions about a merged ralph PR/MR's leftovers (ported from cyralph's
 * `engine/cleanup.ts` and the messages of `SessionManager.cleanupMerged`),
 * asked in the run's agent session as select elicitations: stash entries
 * nobody applied, and a local branch with commits the merge doesn't contain.
 */

export const PUSH_STASHES = "Push to a branch on origin";
export const DROP_STASHES = "Drop";
export const PUSH_BRANCH = "Push to origin";
export const DELETE_BRANCH = "Delete";

/** Default for `unmergedBranchTimeoutMinutes`. */
export const UNMERGED_BRANCH_TIMEOUT_MINUTES = 60;

/** An open cleanup question (callers add what identifies it, e.g. its lane). */
export interface CleanupQuestionRef {
  kind: "stashes" | "branch";
}

export function cleanupOptions(question: CleanupQuestionRef): [string, string] {
  return question.kind === "stashes" ? [PUSH_STASHES, DROP_STASHES] : [PUSH_BRANCH, DELETE_BRANCH];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Matches a reply to a pending cleanup question (`pending` oldest first),
 * like a repository selection: the option's value (what the tracker sends for a
 * picked option), its 1-based number when only one question is open, or a
 * short reply with a word that only one open option has ("drop", "delete",
 * "push"). Newer questions win. Undefined: not an answer.
 */
export function matchCleanupAnswer<Q extends CleanupQuestionRef>(
  reply: string,
  pending: readonly Q[],
): { question: Q; option: string } | undefined {
  const text = norm(reply);
  if (!text) return undefined;
  const newestFirst = [...pending].reverse();
  for (const question of newestFirst) {
    const option = cleanupOptions(question).find((o) => norm(o) === text);
    if (option) return { question, option };
  }
  const only = pending.length === 1 ? pending[0] : undefined;
  if (only && /^[12]$/.test(text)) {
    return { question: only, option: cleanupOptions(only)[Number(text) - 1] ?? "" };
  }
  // A longer reply is guidance that happens to use one of these words, not an answer.
  const words = new Set(text.split(" "));
  if (words.size > 3) return undefined;
  const hits = newestFirst.flatMap((question) =>
    cleanupOptions(question)
      .filter((o) => words.has(norm(o).split(" ")[0] ?? ""))
      .map((option) => ({ question, option })),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "The pull request <url> was merged, so I removed its worktree…" (cyralph's wording). */
export function mergedCleanupMessage(args: {
  term: string;
  prUrl: string;
  branch: string;
  /** The branch was kept: it has unmerged commits. */
  keptBranch: boolean;
  /** The worktree's uncommitted changes were stashed as this entry. */
  stashed?: string | null;
}): string {
  const stashedNote = args.stashed
    ? ` Its uncommitted changes are stashed (\`${args.stashed.slice(0, 10)}\`).`
    : "";
  return args.keptBranch
    ? `The ${args.term} ${args.prUrl} was merged, so I removed its worktree, but kept the local branch \`${args.branch}\`.${stashedNote}`
    : `The ${args.term} ${args.prUrl} was merged, so I removed its worktree and the local branch \`${args.branch}\`.${stashedNote}`;
}

/**
 * Says the worktree of a PR/MR closed without merging was removed; its local
 * branch (and the one on origin) stays.
 */
export function closedCleanupMessage(args: {
  term: string;
  prUrl: string;
  branch: string;
  /** The worktree's uncommitted changes were stashed as this entry. */
  stashed?: string | null;
}): string {
  const stashedNote = args.stashed
    ? ` Its uncommitted changes are stashed (\`${args.stashed.slice(0, 10)}\`).`
    : "";
  return `The ${args.term} ${args.prUrl} was closed without merging, so I removed its worktree. The branch \`${args.branch}\` stays, here and on origin.${stashedNote}`;
}

/** The question about stash entries of the epic nobody applied. */
export function stashQuestion(args: {
  epic: string;
  repository: string;
  stashBranch: string;
  entries: ReadonlyArray<{ sha: string; label: string; date: string }>;
}): string {
  const n = args.entries.length;
  return [
    `${plural(n, "stashed change")} from ${args.epic} ${n === 1 ? "was" : "were"} never applied:`,
    args.entries.map((e) => `- \`${e.sha.slice(0, 10)}\` ${e.label} (${e.date})`).join("\n"),
    `**${PUSH_STASHES}** keeps them on \`${args.stashBranch}\` (one commit each) and drops them here; **${DROP_STASHES}** drops them. Until you answer they stay in \`${args.repository}\`'s stash.`,
  ].join("\n\n");
}

/** The question about a kept branch whose commits weren't merged; it's deleted without an answer. */
export function branchQuestion(args: { branch: string; commits: number; minutes: number }): string {
  const { branch, commits, minutes } = args;
  return `\`${branch}\` has ${commits} commit${commits === 1 ? " that wasn't" : "s that weren't"} merged.\n\n**${PUSH_BRANCH}** pushes it to \`origin\` and then deletes it here; **${DELETE_BRANCH}** deletes it. Without an answer within ${plural(minutes, "minute")} I'll delete it.`;
}

/** What was done about the stash entries. */
export function stashAnswerMessage(args: {
  option: string;
  count: number;
  epic: string;
  stashBranch: string;
}): string {
  const what = plural(args.count, "stashed change");
  return args.option === PUSH_STASHES
    ? `Pushed ${what} to \`${args.stashBranch}\` on origin (one commit each) and dropped ${args.count === 1 ? "it" : "them"} here.`
    : `Dropped ${what} from ${args.epic}.`;
}

/** What was done about the kept branch. */
export function branchAnswerMessage(args: {
  option: string;
  branch: string;
  commits: number;
}): string {
  return args.option === PUSH_BRANCH
    ? `Pushed \`${args.branch}\` to origin and deleted the local branch.`
    : `Deleted the local branch \`${args.branch}\` with its ${plural(args.commits, "unmerged commit")}.`;
}

/** The kept branch was deleted because nobody answered in time. */
export function branchExpiredMessage(args: {
  branch: string;
  commits: number;
  minutes: number;
}): string {
  return `Nobody answered within ${plural(args.minutes, "minute")}, so I deleted the local branch \`${args.branch}\` with its ${plural(args.commits, "unmerged commit")}.`;
}

/** Carrying out an answer failed; it can be given again. */
export function cleanupAnswerFailedMessage(option: string, error: string): string {
  return `I couldn't do that (${option}): ${error}\n\nAnswer again to retry.`;
}
