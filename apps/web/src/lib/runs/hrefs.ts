/**
 * Client-safe links between the screens: a run on Runs (`runHref`, `runListHref`) and an
 * agent on Fleet (`agentHref`). Every agent link uses `agentHref`.
 */
export { RUNS_PATH, runHref, runListHref, type RunListLinkFilter } from "./links";

/** An agent's page on Fleet. */
export function agentHref(agentId: string): string {
  return `/fleet/${agentId}`;
}
