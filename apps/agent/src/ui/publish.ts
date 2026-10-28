import type { AttemptChange, AttemptHistory } from "../attempts/history.js";
import type { ClaudeStatusReporter } from "../claude-status.js";
import type { LogRing } from "../logs/ring.js";
import type { LocalSettingsStore } from "../settings.js";
import type { AgentStorage } from "../storage.js";
import type { UiEventHub } from "./events.js";

/** Maps what changes locally to the page's live stream. */
export function publishLocalChanges(
  hub: UiEventHub,
  sources: {
    settings: LocalSettingsStore;
    history: AttemptHistory;
    claude: ClaudeStatusReporter;
    storage: AgentStorage;
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
  const onClaude = () => hub.publish("claude");
  const onStorage = () => {
    hub.publish("storage");
    hub.publish("repos");
  };
  sources.settings.on("change", onSettings);
  sources.history.on("change", onAttempt);
  sources.claude.on("change", onClaude);
  sources.storage.on("change", onStorage);
  const unsubscribeLogs = sources.ring?.subscribe((entry) =>
    hub.publish("logs", { data: [entry] }),
  );
  return () => {
    sources.settings.off("change", onSettings);
    sources.history.off("change", onAttempt);
    sources.claude.off("change", onClaude);
    sources.storage.off("change", onStorage);
    unsubscribeLogs?.();
  };
}
