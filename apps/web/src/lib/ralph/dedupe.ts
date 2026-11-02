/** At most one queued or running job per run (also enforced by the jobs' dedupe key). */
export function runDedupeKey(runId: string): string {
  return `ralph-run:${runId}`;
}
