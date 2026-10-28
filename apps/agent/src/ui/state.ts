/**
 * `GET /api/state`: what every page of the agent page needs at once (the
 * daemon's status and connection, the settings in force, the update state,
 * Claude's login) and the nav's problem dots.
 */
import type { ClaudeStatus } from "../claude-status.js";
import type {
  DaemonHostTool,
  DaemonHostTools,
  DaemonStatus,
  DaemonVersionPolicy,
} from "../daemon.js";
import type { Logger } from "../logger.js";
import type { LocalSettingsState } from "../settings.js";
import type { StorageFilesystem } from "../storage.js";
import type { SelfUpdater, UpdateRequest } from "../update.js";

/** The nav items that can carry a problem dot. */
export const NAV_PROBLEM_SECTIONS = [
  "overview",
  "host_tools",
  "version",
  "claude",
  "storage",
] as const;
export type NavProblemSection = (typeof NAV_PROBLEM_SECTIONS)[number];

/**
 * Something wrong, shown as a dot on its nav item with `reason` in its accessible name
 * ("Claude, not signed in"), so `reason` continues the item's label in lowercase.
 */
export interface NavProblem {
  section: NavProblemSection;
  reason: string;
}

export interface AgentUiConnection {
  /** A heartbeat got through since the agent started. */
  connected: boolean;
  lastHeartbeatAt: string | null;
  /** When heartbeats started failing; null while they get through. */
  unreachableSince: string | null;
  revoked: boolean;
}

/** The update state, and the "Update now" no heartbeat has acted on yet. */
export type AgentUiUpdate = ReturnType<SelfUpdater["report"]> & { request: UpdateRequest | null };

export type AgentUiHostTool = DaemonHostTool;

/** Host tools as last checked, the names playbooks require and where nothing ever runs from. */
export interface AgentUiHostTools extends DaemonHostTools {
  /** `agent.json` `blockedExecPaths`, read-only. */
  blockedExecPaths: string[];
}

export type AgentUiVersionPolicy = DaemonVersionPolicy;

export interface AgentUiState {
  /** `name` is the machine's hostname, the name enrolling gives an agent by default. */
  agent: { agentId: string; name: string; server: string; version: string };
  status: DaemonStatus;
  connection: AgentUiConnection;
  settings: LocalSettingsState;
  update: AgentUiUpdate;
  /** The organization's version policy from the last heartbeat; null when none. */
  versionPolicy: AgentUiVersionPolicy | null;
  claude: ClaudeStatus | null;
  hostTools: AgentUiHostTools;
  /** Host tools a playbook requires that this agent can't run. */
  missingRequiredHostTools: string[];
  /** Free space per filesystem; empty when it can't be read. */
  filesystems: StorageFilesystem[];
  problems: NavProblem[];
}

export interface AgentUiStateSources {
  agent: AgentUiState["agent"];
  daemon: {
    status(): DaemonStatus;
    missingRequiredHostTools(): string[];
    hostToolsState(): DaemonHostTools;
    versionPolicy(): DaemonVersionPolicy | null;
  };
  settings: { read(): LocalSettingsState };
  updater: Pick<SelfUpdater, "report" | "pendingRequest">;
  /** `agent.json` `blockedExecPaths`. */
  blockedExecPaths: readonly string[];
  claude: { status(): ClaudeStatus | null };
  storage: { filesystems(): Promise<StorageFilesystem[]> };
  logger: Logger;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function navProblems(
  state: Pick<
    AgentUiState,
    "connection" | "update" | "claude" | "missingRequiredHostTools" | "filesystems"
  >,
): NavProblem[] {
  const problems: NavProblem[] = [];
  const { connection, update, claude } = state;
  if (connection.revoked) {
    problems.push({ section: "overview", reason: "revoked" });
  } else if (connection.unreachableSince !== null) {
    problems.push({ section: "overview", reason: "can't reach the control panel" });
  }
  if (state.missingRequiredHostTools.length > 0) {
    problems.push({
      section: "host_tools",
      reason: `${joinNames(state.missingRequiredHostTools)} required but not found`,
    });
  }
  if (update.update?.state === "idle" && update.update.error !== null) {
    problems.push({ section: "version", reason: "the last update failed" });
  }
  if (claude?.status === "signed_out") {
    problems.push({ section: "claude", reason: "not signed in" });
  }
  if (state.filesystems.some((fs) => fs.low)) {
    problems.push({ section: "storage", reason: "low disk" });
  }
  return problems;
}

export async function agentUiState(sources: AgentUiStateSources): Promise<AgentUiState> {
  const status = sources.daemon.status();
  let filesystems: StorageFilesystem[] = [];
  try {
    filesystems = await sources.storage.filesystems();
  } catch (error) {
    sources.logger.warn({ err: error }, "cannot read free disk space");
  }
  const partial = {
    status,
    connection: {
      connected: status.connected,
      lastHeartbeatAt: status.lastHeartbeatAt,
      unreachableSince: status.unreachableSince,
      revoked: status.revoked,
    },
    update: { ...sources.updater.report(), request: sources.updater.pendingRequest() },
    claude: sources.claude.status(),
    missingRequiredHostTools: sources.daemon.missingRequiredHostTools(),
    filesystems,
  };
  return {
    agent: sources.agent,
    settings: sources.settings.read(),
    versionPolicy: sources.daemon.versionPolicy(),
    hostTools: {
      ...sources.daemon.hostToolsState(),
      blockedExecPaths: [...sources.blockedExecPaths],
    },
    ...partial,
    problems: navProblems(partial),
  };
}
