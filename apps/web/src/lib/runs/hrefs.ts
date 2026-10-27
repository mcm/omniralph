/**
 * Client-safe links between the screens: a run on Runs (`runHref`, `runListHref`) and an
 * agent on Fleet (`agentHref`, `FLEET_PATH`). Every agent link uses `agentHref`.
 */
export {
  RUNS_PATH,
  runHref,
  runListHref,
  type RunLinkState,
  type RunListLinkFilter,
} from "./links";

/** Fleet: every agent of the user's scope. */
export const FLEET_PATH = "/fleet";

/** An agent's page on Fleet. */
export function agentHref(agentId: string): string {
  return `/fleet/${agentId}`;
}
