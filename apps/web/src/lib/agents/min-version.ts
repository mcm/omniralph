import { AGENT_MIN_VERSION, AGENT_PACKAGE, agentVersionAtLeast } from "@omniralph/shared";

/**
 * Why a desired version can't be saved because it's below `AGENT_MIN_VERSION` (the deprecated
 * 0.x releases under the same name), or null when it can be.
 */
export function agentVersionTooOld(version: string): string | null {
  return agentVersionAtLeast(version, AGENT_MIN_VERSION)
    ? null
    : `Agents run ${AGENT_PACKAGE} ${AGENT_MIN_VERSION} or later: enter ${AGENT_MIN_VERSION} or a later version.`;
}
