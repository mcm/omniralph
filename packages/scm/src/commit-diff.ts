/** Files `ScmAdapter.getCommitDiff` returns unless told otherwise. */
export const DEFAULT_COMMIT_DIFF_MAX_FILES = 100;
/** Lines of one file's patch `ScmAdapter.getCommitDiff` keeps. */
export const MAX_PATCH_LINES = 2_000;

/** A patch cut to its first {@link MAX_PATCH_LINES} lines (without a trailing newline). */
export function capPatch(patch: string): { patch: string; truncated: boolean } {
  const lines = patch.replace(/\n$/, "").split("\n");
  if (lines.length <= MAX_PATCH_LINES) return { patch: lines.join("\n"), truncated: false };
  return { patch: lines.slice(0, MAX_PATCH_LINES).join("\n"), truncated: true };
}

/** Added and removed lines of a unified diff (hunk headers and `\ No newline` excluded). */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** `maxFiles` from the options, at least 1. */
export function maxFilesOf(options: { maxFiles?: number } | undefined): number {
  return Math.max(1, Math.floor(options?.maxFiles ?? DEFAULT_COMMIT_DIFF_MAX_FILES));
}
