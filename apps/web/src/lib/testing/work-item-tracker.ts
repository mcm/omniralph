/**
 * A work item tracker for tests of modules that reach trackers only through
 * `WorkItemTracker` (the chat, Ask): the Linear adapter over a fake workspace,
 * so those tests import nothing from `@/lib/linear/`.
 */
import { DEFAULT_TRACKER_STATE_MAPPING } from "@omniralph/db";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { LinearWorkItemTracker } from "@/lib/work-items/linear";

export interface FakeWorkItemTracker {
  tracker: LinearWorkItemTracker;
  /** The fake workspace behind it: arrange teams and items, read what was created. */
  workspace: FakeLinearGateway;
}

/** A tracker over an empty fake workspace with the given teams (default: `ENG`). */
export function fakeWorkItemTracker(
  options: { teams?: Array<{ id: string; key: string; name: string }> } = {},
): FakeWorkItemTracker {
  const workspace = new FakeLinearGateway();
  if (options.teams) workspace.teams = options.teams;
  const tracker = new LinearWorkItemTracker({
    gateway: workspace,
    integrationId: "integration-1",
    stateMapping: structuredClone(DEFAULT_TRACKER_STATE_MAPPING),
    saveStateMapping: async () => undefined,
  });
  return { tracker, workspace };
}
