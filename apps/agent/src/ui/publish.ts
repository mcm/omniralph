import type { AttemptChange, AttemptHistory } from "../attempts/history.js";
import type { ClaudeStatusReporter } from "../claude-status.js";
import type { LogRing } from "../logs/ring.js";
import type { InstallHistory, InstallSummary } from "../packages/history.js";
import type { LocalSettingsStore } from "../settings.js";
import type { DaemonHostTools } from "../daemon.js";
import type { AgentStorage } from "../storage.js";
import type { SelfUpdater } from "../update.js";
import type { UiEventHub } from "./events.js";

/** Maps what changes locally to the page's live stream. */
export function publishLocalChanges(
  hub: UiEventHub,
  sources: {
    settings: LocalSettingsStore;
    history: AttemptHistory;
    claude: ClaudeStatusReporter;
    storage: AgentStorage;
    installs?: InstallHistory;
    updater?: Pick<SelfUpdater, "on" | "off">;
    ring?: LogRing;
  },
): () => void {
  const onSettings = () => hub.publish("settings");
  const onAttempt = (change: AttemptChange) => {
    if (change.kind === "transcript") {
      hub.publish("transcript", { ids: [change.id], data: change.events });
    } else {
      hub.publish("attempts", { ids: [change.attempt.id] });
      // A finished repo sync is a repo's last sync.
      if (change.kind === "finished") hub.publish("repos");
    }
  };
  // An install queued, finished or failed: the history, and what is installed.
  const onInstall = (install: InstallSummary) => hub.publish("packages", { ids: [install.id] });
  const onClaude = () => hub.publish("claude");
  // "Update now", a drain, an install, a failure: the Version page and the nav's dot.
  const onUpdate = () => hub.publish("update");
  const onStorage = () => {
    hub.publish("storage");
    hub.publish("repos");
  };
  sources.settings.on("change", onSettings);
  sources.history.on("change", onAttempt);
  sources.installs?.on("change", onInstall);
  sources.claude.on("change", onClaude);
  sources.updater?.on("change", onUpdate);
  sources.storage.on("change", onStorage);
  const unsubscribeLogs = sources.ring?.subscribe((entry) =>
    hub.publish("logs", { data: [entry] }),
  );
  return () => {
    sources.settings.off("change", onSettings);
    sources.history.off("change", onAttempt);
    sources.installs?.off("change", onInstall);
    sources.claude.off("change", onClaude);
    sources.updater?.off("change", onUpdate);
    sources.storage.off("change", onStorage);
    unsubscribeLogs?.();
  };
}

/**
 * What each heartbeat changes on the page, called after every heartbeat (it got
 * through or not): the status and update state always; the repos when the pins
 * changed; the host tools when their check found something new (a path saved
 * on the page is checked by the heartbeat it triggers).
 */
export function heartbeatPublisher(
  hub: UiEventHub,
  daemon: {
    pinnedRepositories(): readonly unknown[];
    hostToolsState(): DaemonHostTools;
  },
): () => void {
  let lastPins = "[]";
  let lastHostTools = JSON.stringify(daemon.hostToolsState());
  return () => {
    hub.publish("status");
    hub.publish("update");
    const pins = JSON.stringify(daemon.pinnedRepositories());
    if (pins !== lastPins) hub.publish("repos");
    lastPins = pins;
    const hostTools = JSON.stringify(daemon.hostToolsState());
    if (hostTools !== lastHostTools) hub.publish("host_tools");
    lastHostTools = hostTools;
  };
}
