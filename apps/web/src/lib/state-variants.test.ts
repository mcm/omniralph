import { describe, expect, it } from "vitest";
import {
  harnessConnectionState,
  HARNESS_CONNECTION_VARIANTS,
  HARNESS_UPDATE_STATUS_VARIANTS,
  JOB_STATUS_VARIANTS,
  RALPH_RUN_STATUS_VARIANTS,
  RALPH_STORY_STATUS_VARIANTS,
  REVIEW_STATUS_VARIANTS,
  SEVERITY_VARIANTS,
} from "./state-variants";

// The State Vocabulary Rule (apps/web/DESIGN.md), by state name.
const RULE: Record<string, string> = {
  completed: "success",
  up_to_date: "success",
  online: "success",
  blocked: "warning",
  waiting: "warning",
  manual: "warning",
  failed: "danger",
  exhausted: "danger",
  budget_exhausted: "danger",
  expired: "danger",
  revoked: "danger",
  running: "info",
  updating: "info",
  pending: "neutral",
  queued: "neutral",
  canceled: "neutral",
  stopped: "neutral",
  skipped: "neutral",
  offline: "neutral",
};

const MAPS = {
  run: RALPH_RUN_STATUS_VARIANTS,
  story: RALPH_STORY_STATUS_VARIANTS,
  job: JOB_STATUS_VARIANTS,
  review: REVIEW_STATUS_VARIANTS,
  harness: HARNESS_CONNECTION_VARIANTS,
  harnessUpdate: HARNESS_UPDATE_STATUS_VARIANTS,
};

describe("state variants", () => {
  for (const [name, map] of Object.entries(MAPS)) {
    it(`maps every ${name} state as the State Vocabulary Rule says`, () => {
      for (const [state, variant] of Object.entries(map)) {
        expect(RULE[state], `${name} state "${state}" is missing from the rule`).toBeDefined();
        expect(variant, `${name} state "${state}"`).toBe(RULE[state]);
      }
    });
  }

  it("keeps severities off the running variant and tells the top three apart", () => {
    expect(Object.values(SEVERITY_VARIANTS)).not.toContain(RULE.running);
    const top = [SEVERITY_VARIANTS.critical, SEVERITY_VARIANTS.high, SEVERITY_VARIANTS.medium];
    expect(new Set(top).size).toBe(top.length);
  });

  it("treats a revoked harness as revoked even when it is online", () => {
    expect(harnessConnectionState({ online: true, revoked: true })).toBe("revoked");
    expect(harnessConnectionState({ online: true, revoked: false })).toBe("online");
    expect(harnessConnectionState({ online: false, revoked: false })).toBe("offline");
  });
});
