import { FakeTrackerGateway } from "@omniralph/tracker/testing";

/**
 * A fake tracker for the ralph orchestrator's `RalphDeps.linear`, for tests of modules
 * that don't import from `@/lib/tracker/` or `@omniralph/tracker` themselves (the chat).
 */
export function fakeRalphTracker(): FakeTrackerGateway {
  return new FakeTrackerGateway();
}
