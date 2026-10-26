/**
 * The machine the agent runs on, reported in every heartbeat so the control panel
 * can tell agents apart: the host name and, on a Coder workspace, its owner and name.
 */
import { hostname as osHostname } from "node:os";
import { AGENT_HOST_NAME_MAX, type AgentHostReport } from "@omniralph/shared";

/**
 * The agent's host. `coder` is set only when both `CODER_WORKSPACE_OWNER_NAME` and
 * `CODER_WORKSPACE_NAME` are; no other environment value is read.
 */
export function agentHost(
  env: NodeJS.ProcessEnv = process.env,
  hostname: () => string = osHostname,
): AgentHostReport {
  const owner = env.CODER_WORKSPACE_OWNER_NAME?.trim();
  const workspace = env.CODER_WORKSPACE_NAME?.trim();
  return {
    hostname: hostname().slice(0, AGENT_HOST_NAME_MAX),
    coder:
      owner && workspace
        ? {
            owner: owner.slice(0, AGENT_HOST_NAME_MAX),
            workspace: workspace.slice(0, AGENT_HOST_NAME_MAX),
          }
        : null,
  };
}
