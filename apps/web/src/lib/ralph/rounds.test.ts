import type { RalphRoundMetrics } from "@omniralph/db";
import { MAX_ROUNDS_PER_STORY, STALL_ROUNDS, type RalphStoryMetric } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { addRoundMetric, bestValue, isStalled, metricTrend } from "./rounds";

const at = new Date("2026-10-12T00:00:00Z");
const score = (value: number): RalphStoryMetric => ({
  name: "critique score",
  value,
  direction: "higher",
});

/** Replays the values round by round; returns the round the stall rule fired in, if it did. */
function replay(values: number[], metric = score, stallRounds = STALL_ROUNDS) {
  let history: RalphRoundMetrics | null = null;
  for (const [i, value] of values.entries()) {
    history = addRoundMetric(history, metric(value), i + 1, at);
    if (isStalled(history, stallRounds)) return { stalledAt: i + 1, history };
  }
  return { stalledAt: null, history: history! };
}

describe("the stall rule", () => {
  it("lets UI-19's review loop run every round: its best improved in every 3 rounds", () => {
    // UI-19's critique scores, round by round, until it cleared its bar.
    const ui19 = [23, 26, 26, 29, 27, 30, 30, 30, 31, 30, 34];
    const { stalledAt, history } = replay(ui19);
    expect(stalledAt).toBeNull();
    expect(history.values.map((v) => v.round)).toEqual(ui19.map((_, i) => i + 1));
    expect(bestValue(history)).toBe(34);
    // The round cap is separate: past the default, a loop like this needs `/continue` or a higher cap.
    expect(MAX_ROUNDS_PER_STORY).toBe(8);
  });

  it("sets a flat metric aside after 3 rounds", () => {
    expect(replay([20, 20, 20]).stalledAt).toBe(3);
    expect(replay([20, 19, 18, 20]).stalledAt).toBe(3);
  });

  it("counts the rounds since the best last improved", () => {
    expect(replay([20, 21, 21, 21, 21]).stalledAt).toBe(5);
    expect(replay([20, 21, 21, 22, 22, 22, 23]).stalledAt).toBeNull();
    expect(replay([20, 20, 20], score, 4).stalledAt).toBeNull();
  });

  it("follows the metric's direction", () => {
    const lower = (value: number): RalphStoryMetric => ({
      name: "errors",
      value,
      direction: "lower",
    });
    expect(replay([9, 8, 7, 6, 5], lower).stalledAt).toBeNull();
    expect(replay([9, 10, 11], lower).stalledAt).toBe(3);
    expect(replay([5, 6, 7, 8], score).stalledAt).toBeNull();
  });

  it("starts afresh when the metric is renamed or reversed", () => {
    const first = replay([20, 20]).history;
    const renamed = addRoundMetric(first, { ...score(20), name: "score" }, 3, at);
    expect(renamed.values).toEqual([{ round: 3, value: 20, at: at.toISOString() }]);
    expect(isStalled(renamed, STALL_ROUNDS)).toBe(false);
    const reversed = addRoundMetric(first, { ...score(20), direction: "lower" }, 3, at);
    expect(reversed.values).toHaveLength(1);
  });
});

describe("metricTrend", () => {
  it("shows the values with the direction and target", () => {
    const history = addRoundMetric(replay([23, 26]).history, { ...score(29), target: 34 }, 3, at);
    expect(metricTrend(history)).toBe("critique score (higher is better, target 34): 23 → 26 → 29");
    expect(metricTrend(replay([1]).history)).toBe("critique score (higher is better): 1");
  });
});
