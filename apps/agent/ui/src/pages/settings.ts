/** What every settings page shares: the 409's message and writing a save's answer into the state. */
import type { LocalSettingsState } from "../../../src/settings.js";
import type { AgentUiState } from "../state.js";

/** Shown when the file changed on the machine since the page read it (a 409). */
export const SETTINGS_CHANGED = "These settings changed on the machine. Review and save again.";

/** The state with `settings` in place of its own. */
export function withSettings(
  state: AgentUiState | undefined,
  settings: LocalSettingsState,
): AgentUiState | undefined {
  return state && { ...state, settings };
}
