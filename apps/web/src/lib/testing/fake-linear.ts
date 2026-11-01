import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";

/**
 * A fake Linear workspace for the ralph orchestrator's `RalphDeps.linear`, for tests of
 * modules that don't import from `@/lib/tracker/` or `@omniralph/tracker` themselves (the chat).
 */
export function fakeRalphLinear(): FakeLinearGateway {
  return new FakeLinearGateway();
}
