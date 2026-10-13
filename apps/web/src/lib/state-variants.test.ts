import { describe, expect, it } from "vitest";
import {
  harnessConnectionState,
  integrationState,
  INTEGRATION_STATE_VARIANTS,
  HARNESS_CONNECTION_VARIANTS,
  HARNESS_UPDATE_STATUS_VARIANTS,
  JOB_STATUS_VARIANTS,
  RALPH_RUN_STATUS_VARIANTS,
  RALPH_STORY_STATUS_VARIANTS,
  REVIEW_STATUS_VARIANTS,
  SEVERITY_VARIANT_WEIGHT,
  SEVERITY_VARIANTS,
  stateLabel,
} from "./state-variants";
import { FINDING_SEVERITIES } from "./reviews/display";

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

  it("ramps severities from loudest (critical) to quietest (info)", () => {
    const weights = FINDING_SEVERITIES.map((s) => SEVERITY_VARIANT_WEIGHT[SEVERITY_VARIANTS[s]]);
    for (let i = 1; i < weights.length; i++) {
      expect(
        weights[i],
        `${FINDING_SEVERITIES[i]} is quieter than ${FINDING_SEVERITIES[i - 1]}`,
      ).toBeLessThan(weights[i - 1]!);
    }
  });

  it("gives every severity its own variant and never a solid fill", () => {
    const variants = FINDING_SEVERITIES.map((s) => SEVERITY_VARIANTS[s]);
    expect(new Set(variants).size).toBe(FINDING_SEVERITIES.length);
    expect(variants).not.toContain("accent");
  });

  it("never gives a severity the look of a running or in-progress state", () => {
    const running = new Set<string>(
      Object.values(MAPS).flatMap((map) =>
        Object.entries(map)
          .filter(([state]) => RULE[state] === "info")
          .map(([, variant]) => variant),
      ),
    );
    for (const severity of FINDING_SEVERITIES) {
      expect(running.has(SEVERITY_VARIANTS[severity]), severity).toBe(false);
    }
  });

  it("warns about a saved integration the server isn't configured for", () => {
    expect(integrationState(true, true)).toBe("connected");
    expect(integrationState(true, false)).toBe("unconfigured");
    expect(integrationState(false, false)).toBe("disconnected");
    expect(INTEGRATION_STATE_VARIANTS.unconfigured).toBe("warning");
  });

  it("treats a revoked harness as revoked even when it is online", () => {
    expect(harnessConnectionState({ online: true, revoked: true })).toBe("revoked");
    expect(harnessConnectionState({ online: true, revoked: false })).toBe("online");
    expect(harnessConnectionState({ online: false, revoked: false })).toBe("offline");
  });
});

describe("stateLabel", () => {
  it("writes every state in sentence case", () => {
    expect(stateLabel("running")).toBe("Running");
    expect(stateLabel("in_progress")).toBe("In progress");
    expect(stateLabel("too_large")).toBe("Too large");
    expect(stateLabel("")).toBe("");
  });
});
