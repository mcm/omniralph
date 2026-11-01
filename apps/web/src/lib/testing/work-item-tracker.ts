/**
 * A work item tracker for tests of modules that reach trackers only through
 * `WorkItemTracker` (the chat, Ask): the gateway-backed tracker over a fake
 * tracker, so those tests import nothing from `@/lib/tracker/` or `@omniralph/tracker`.
 */
import { DEFAULT_TRACKER_STATE_MAPPING } from "@omniralph/db";
import type { TrackerCapability } from "@omniralph/tracker";
import { FakeTrackerGateway, NO_CAPABILITIES } from "@omniralph/tracker/testing";
import { GatewayWorkItemTracker } from "@/lib/work-items/gateway-tracker";

export interface FakeWorkItemTracker {
  tracker: GatewayWorkItemTracker;
  /** The fake tracker behind it: arrange teams and items, read what was created. */
  workspace: FakeTrackerGateway;
}

/**
 * A tracker over an empty fake tracker with the given teams (default: `ENG`), with every
 * optional capability (sessions, delegation, documents, uploads) unless `capabilities`
 * turns some off (`"none"`: all of them).
 */
export function fakeWorkItemTracker(
  options: {
    teams?: Array<{ id: string; key: string; name: string }>;
    capabilities?: Partial<Record<TrackerCapability, boolean>> | "none";
  } = {},
): FakeWorkItemTracker {
  const { capabilities } = options;
  const workspace = new FakeTrackerGateway(
    capabilities ? { capabilities: capabilities === "none" ? NO_CAPABILITIES : capabilities } : {},
  );
  if (options.teams) workspace.teams = options.teams;
  const tracker = new GatewayWorkItemTracker({
    gateway: workspace,
    integrationId: "integration-1",
    stateMapping: structuredClone(DEFAULT_TRACKER_STATE_MAPPING),
    saveStateMapping: async () => undefined,
  });
  return { tracker, workspace };
}
