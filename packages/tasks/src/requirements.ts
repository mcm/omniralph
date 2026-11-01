import { z } from "zod";
import type { AgentTools, TaskDefinition, ToolSettings } from "./definitions.js";
import { parseInstallableMcpServerRef } from "./installables.js";
import type { TaskType } from "./kinds.js";
import { templateVariables } from "./template.js";
import { taskVariables, VARIABLES, type VariableDefinition } from "./variables.js";

/**
 * What a run of a task needs from the agent that claims it, derived from
 * the definition when it's saved and stored with it: the installables it
 * uses, the host tools it shells out to and the lowest agent version that
 * provides everything it uses (null for any).
 */
export const TaskRequirements = z.object({
  minAgentVersion: z.string().min(1).nullable().default(null),
  installables: z.array(z.string().min(1)).default([]),
  hostTools: z.array(z.string().min(1)).default([]),
});
export type TaskRequirements = z.infer<typeof TaskRequirements>;
export type TaskRequirementsInput = z.input<typeof TaskRequirements>;

/**
 * The first agent release that runs each task type through its lifecycle
 * (and provides the type's variables). `@omniralph/shared` exports them as
 * `QUERY_TASKS_MIN_AGENT_VERSION`, `REVIEW_TASKS_MIN_AGENT_VERSION` and
 * `CODING_TASKS_MIN_AGENT_VERSION`.
 */
export const AGENT_VERSION_BY_TASK_TYPE: Record<TaskType, string> = {
  query: "0.9.0",
  review: "0.10.0",
  coding: "0.11.0",
};

/**
 * The first agent release that runs a task's setup and teardown commands
 * (`SETUP_COMMANDS_MIN_AGENT_VERSION` in `@omniralph/shared`).
 */
export const AGENT_VERSION_FOR_COMMANDS = "0.10.0";

/**
 * The first agent release that speaks the tracker-neutral protocol: the
 * `tracker_*` tools under `/api/agent/runs/{id}/tracker/*` with the
 * `tracker:read` scope (`tools.tracker`, `toolSettings.trackerRead`) and the
 * ralph payloads' `trackerIssueId`, `trackerProvider` and `source: "tracker"`
 * (`TRACKER_PROTOCOL_MIN_AGENT_VERSION` in `@omniralph/shared`). Older agents
 * know only the Linear names, so runs that use any of it carry this version.
 */
export const AGENT_VERSION_FOR_TRACKER = "2.1.0";

/**
 * Whether runs of `task` use the tracker protocol (`AGENT_VERSION_FOR_TRACKER`):
 * it turns on the read-only tracker tools, or it is a coding task, whose runs'
 * ralph payloads carry the tracker fields.
 */
export function usesTrackerProtocol(
  task: Pick<TaskDefinition, "taskType"> & { toolSettings?: Pick<ToolSettings, "trackerRead"> },
): boolean {
  return task.taskType === "coding" || task.toolSettings?.trackerRead === true;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/;

/** The higher of two `x.y.z` versions (`a` when they're equal or `b` doesn't parse). */
function higherVersion(a: string, b: string): string {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pb) return a;
  if (!pa) return b;
  for (let i = 1; i <= 3; i++) {
    const [x, y] = [Number(pa[i]), Number(pb[i])];
    if (x !== y) return x > y ? a : b;
  }
  return a;
}

type RequirementFields = Pick<
  TaskDefinition,
  "taskType" | "triggers" | "promptTemplate" | "setupCommands" | "teardownCommands"
> &
  Partial<Pick<TaskDefinition, "requires" | "toolSettings">>;

/** The fields of a run spec's agent its requirements come from. */
export type RequirementAgentFields = { tools: Pick<AgentTools, "mcpServers"> };

/**
 * The installables and host tools a run of `task` on `agent` needs: the
 * task's `requires`, plus each installable whose MCP servers the agent lists
 * (`<package>:<server>`), each once and sorted.
 */
export function deriveAgentRequirements(
  task: Partial<Pick<TaskDefinition, "requires">>,
  agent?: RequirementAgentFields | null,
): Pick<TaskRequirements, "installables" | "hostTools"> {
  const installables = new Set(task.requires?.installables ?? []);
  for (const entry of agent?.tools.mcpServers ?? []) {
    const ref = parseInstallableMcpServerRef(entry);
    if (ref) installables.add(ref.installable);
  }
  return {
    installables: [...installables].sort(),
    hostTools: [...new Set(task.requires?.hostTools ?? [])].sort(),
  };
}

/**
 * What a run of `task` (on `agent`) needs: the agent release that runs its
 * task type, its setup and teardown commands (if any), the tracker protocol
 * (if it uses it, `usesTrackerProtocol`) and every task-type
 * variable its template uses (`minAgentVersion` in `catalog`), whichever is
 * highest; and the installables and host tools of `deriveAgentRequirements`.
 */
export function deriveTaskRequirements(
  task: RequirementFields,
  catalog: readonly VariableDefinition[] = VARIABLES,
  agent?: RequirementAgentFields | null,
): TaskRequirements {
  const entries = new Map(catalog.map((variable) => [variable.name, variable]));
  const versions = [AGENT_VERSION_BY_TASK_TYPE[task.taskType]];
  if (task.setupCommands.length > 0 || task.teardownCommands.length > 0) {
    versions.push(AGENT_VERSION_FOR_COMMANDS);
  }
  if (usesTrackerProtocol(task)) versions.push(AGENT_VERSION_FOR_TRACKER);
  for (const name of templateVariables(task.promptTemplate, taskVariables(task, catalog))) {
    const entry = entries.get(name);
    if (entry?.source === "taskType" && entry.minAgentVersion !== undefined) {
      versions.push(entry.minAgentVersion);
    }
  }
  return {
    minAgentVersion: versions.reduce(higherVersion),
    ...deriveAgentRequirements(task, agent),
  };
}
