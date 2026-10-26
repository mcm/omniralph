import type { AgentUpdateReport, SelfUpdateSupport } from "@omniralph/shared";

/**
 * Where an agent stands against its desired version:
 * - `up_to_date`: it runs the desired version (or none is chosen)
 * - `updating`: it will update itself (an admin may have asked it to with "Update now"),
 *   or is draining, installing or confirming
 * - `failed`: the desired version failed on it, so it won't try it again
 * - `manual`: it can't update itself (not under pm2, or an older agent)
 */
export type AgentUpdateStatus = "up_to_date" | "updating" | "failed" | "manual";

export const UPDATE_STATUS_LABELS: Record<AgentUpdateStatus, string> = {
  up_to_date: "Up to date",
  updating: "Updating",
  failed: "Failed",
  manual: "Update manually",
};

export function agentUpdateStatus(agent: {
  version: string | null;
  desiredVersion: string | null;
  selfUpdate: SelfUpdateSupport | null;
  update: AgentUpdateReport | null;
  failedVersions: string[];
  /** An admin's "Update now" the agent hasn't acted on yet. */
  updateRequested?: boolean;
}): AgentUpdateStatus {
  const { desiredVersion, update } = agent;
  const busy = update !== null && update.state !== "idle";
  if (agent.updateRequested && agent.selfUpdate === "supported") return "updating";
  if (desiredVersion === null) return busy ? "updating" : "up_to_date";
  if (agent.version === desiredVersion && !busy) return "up_to_date";
  if (agent.failedVersions.includes(desiredVersion)) return "failed";
  if (busy) return "updating";
  return agent.selfUpdate === "supported" ? "updating" : "manual";
}
