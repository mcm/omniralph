/**
 * The Version page's copy and pure helpers: the organization's policy, the update state,
 * the pin's validation and its save bar line.
 */
import { AGENT_MIN_VERSION, AgentVersion, agentVersionAtLeast } from "@omniralph/shared";
import type { StagedChange, StatusTone } from "@omniralph/ui";
import type { AgentUiState } from "../../state.js";

export const PIN_DESCRIPTION = "A pinned version wins over the organization's policy.";
export const NOT_UNDER_PM2 = "This agent can't update itself because it isn't running under pm2.";
export const UPDATE_RUNNING = "An update is already running.";
export const PIN_REQUIRED = "Enter a version";
export const PIN_INVALID = "Enter a version such as 2.0.4";
export const PIN_TOO_OLD = `Use ${AGENT_MIN_VERSION} or later`;
export const FINISHING = "Finishing running work";

/**
 * The organization's policy as words and its version (a badge, Design rule 1): "Track
 * latest" 2.0.4, "Pinned to" 2.0.3, or "None" without a policy.
 */
export function policyParts(policy: AgentUiState["versionPolicy"]): {
  text: string;
  version: string | null;
} {
  if (!policy) return { text: "None", version: null };
  return {
    text: policy.kind === "latest" ? "Track latest" : "Pinned to",
    version: policy.version,
  };
}

/**
 * Why an agent with no update under way runs the version it does, the way the updater decides
 * (`apps/agent/src/update.ts` `wantedVersion`): "Up to date", "Pinned to 2.3.1", "Can't update
 * itself", "Not retrying 2.4.1" (it failed before) or "Updating to 2.4.1 soon" (the next
 * heartbeat starts it).
 */
export function idleVersionText(state: AgentUiState): { text: string; tone: StatusTone } {
  const running = state.agent.version;
  const pin = state.settings.effective.versionPin;
  const target = pin ?? state.versionPolicy?.version ?? null;
  if (target === null || target === running) {
    return { text: pin !== null ? `Pinned to ${pin}` : "Up to date", tone: "neutral" };
  }
  if (state.update.selfUpdate === "unsupported") {
    return { text: "Can't update itself", tone: "neutral" };
  }
  if (state.update.failedVersions.includes(target)) {
    return { text: `Not retrying ${target}`, tone: "neutral" };
  }
  return { text: `Updating to ${target} soon`, tone: "neutral" };
}

/** Where the update is: an "Update now" no heartbeat took yet already reads as the drain. */
export function updateStateText(agent: AgentUiState): {
  text: string;
  tone: StatusTone;
} {
  const { update } = agent;
  const report = update.update;
  const state = report?.state ?? "idle";
  if (state === "draining" || (state === "idle" && update.request !== null)) {
    return { text: FINISHING, tone: "run" };
  }
  if (state === "installing")
    return { text: `Installing ${report?.version ?? ""}`.trim(), tone: "run" };
  if (state === "confirming")
    return { text: `Checking ${report?.version ?? ""}`.trim(), tone: "run" };
  if (report?.error) return { text: "The last update failed", tone: "fail" };
  return idleVersionText(agent);
}

/** An update is under way (asked for, draining, installing or confirming). */
export function updating(update: AgentUiState["update"]): boolean {
  return update.request !== null || (update.update?.state ?? "idle") !== "idle";
}

/** What "Update now" installs: the pin, else the organization's version, else the latest. */
export function updateTarget(state: AgentUiState): string {
  return (
    state.settings.effective.versionPin ?? state.versionPolicy?.version ?? "the latest version"
  );
}

export function updateNowDescription(version: string): string {
  return `Update now? The agent stops taking new work, finishes what's running, installs ${version} and restarts.`;
}

export interface PinDraft {
  pinned: boolean;
  version: string;
}

export function pinDraft(pin: string | null): PinDraft {
  return { pinned: pin !== null, version: pin ?? "" };
}

/** The pin the draft saves (null: none). */
export function draftPin(draft: PinDraft): string | null {
  return draft.pinned ? draft.version.trim() : null;
}

/** The version input's error, or null. */
export function pinError(draft: PinDraft): string | null {
  if (!draft.pinned) return null;
  const version = draft.version.trim();
  if (!version) return PIN_REQUIRED;
  if (!AgentVersion.safeParse(version).success) return PIN_INVALID;
  return agentVersionAtLeast(version, AGENT_MIN_VERSION) ? null : PIN_TOO_OLD;
}

/** The save bar's line for a pin edit. */
export function pinChanges(saved: PinDraft, draft: PinDraft): StagedChange[] {
  const from = draftPin(saved);
  const to = draftPin(draft);
  if (from === to) return [];
  return [
    {
      id: "pin",
      label: "Pinned version",
      from: from ?? "None",
      to: to || "None",
      effect:
        to === null
          ? "The agent follows the organization's policy."
          : `The agent updates to ${to || "it"} when it's free and stays there.`,
    },
  ];
}
