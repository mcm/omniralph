import type { AgentOverview } from "@omniralph/db";
import { agentVersionAtLeast } from "@omniralph/shared";
import { isAgentOnline } from "./display";

/** An agent that would get a query run, and whether it can claim one now. */
export interface QueryAgentStatus {
  name: string;
  version: string | null;
  /**
   * Whether it claims the run: online, accepting `query` tasks, on the run's
   * minimum version or later, with every installable and host tool it requires.
   */
  capable: boolean;
}

/** What a run needs from the agent claiming it, as `claimJob` checks it. */
export interface RunAgentRequirements {
  /** The run's `min_agent_version`; null for none. */
  minAgentVersion: string | null;
  /** `required_installables`: each must be in the agent's `reportedInstallables`. */
  installables: readonly string[];
  /** `required_host_tools`: each must have an effective path on the agent. */
  hostTools: readonly string[];
}

/**
 * The organization's agents that would get a query run in `repositoryId`
 * (its pinned agents when it has some, else all), each saying whether it
 * can claim one now as `claimJob` decides: it accepts `query` tasks (itself or
 * by the organization's default: `effective`), reports
 * the run's minimum version or later, reports every required installable and
 * has an effective path for every required host tool (`usableHostTools`, by
 * agent ID: `listAgentsUsableHostTools`). Revoked and offline agents
 * are left out.
 */
export function queryClaimableAgents(
  agents: readonly AgentOverview[],
  usableHostTools: ReadonlyMap<string, readonly string[]>,
  repositoryId: string,
  requirements: RunAgentRequirements,
  now: Date = new Date(),
): QueryAgentStatus[] {
  const live = agents.filter((h) => !h.revokedAt);
  const pinned = live.filter((h) => h.pinnedRepositories.some((r) => r.id === repositoryId));
  return (pinned.length > 0 ? pinned : live)
    .filter((h) => isAgentOnline(h.lastHeartbeatAt, now))
    .map((h) => ({
      name: h.name,
      version: h.reportedVersion,
      capable:
        h.effective.acceptedTaskTypes.includes("query") &&
        versionCapable(h.reportedVersion, requirements.minAgentVersion) &&
        requirements.installables.every((name) =>
          h.reportedInstallables.some((installable) => installable.name === name),
        ) &&
        requirements.hostTools.every((name) => usableHostTools.get(h.id)?.includes(name)),
    }));
}

/** As `claimJob`: no minimum takes any agent, a minimum one that reported a version. */
function versionCapable(reported: string | null, minimum: string | null): boolean {
  if (minimum === null) return true;
  return reported !== null && agentVersionAtLeast(reported, minimum);
}
