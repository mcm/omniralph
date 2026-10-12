/**
 * Rounds of a review loop: a story that reports blocked and files blocking
 * follow-ups runs again once they're done. Rounds don't use attempts; they
 * have their own cap, and a story that reports a progress metric is set
 * aside once its best value stops improving.
 */
import type { RalphRoundMetrics } from "@omniralph/db";
import type { RalphStoryMetric } from "@omniralph/shared";

/** The story's metric history with this round's value added (a renamed or reversed metric starts afresh). */
export function addRoundMetric(
  history: RalphRoundMetrics | null | undefined,
  metric: RalphStoryMetric,
  round: number,
  now: Date,
): RalphRoundMetrics {
  const same = history?.name === metric.name && history.direction === metric.direction;
  return {
    name: metric.name,
    direction: metric.direction,
    ...(metric.target !== undefined && { target: metric.target }),
    values: [
      ...(same ? history.values : []),
      { round, value: metric.value, at: now.toISOString() },
    ],
  };
}

function better(direction: RalphRoundMetrics["direction"], a: number, b: number): boolean {
  return direction === "higher" ? a > b : a < b;
}

/** The best value of the history; undefined without values. */
export function bestValue(history: RalphRoundMetrics): number | undefined {
  return history.values.reduce<number | undefined>(
    (best, { value }) =>
      best === undefined || better(history.direction, value, best) ? value : best,
    undefined,
  );
}

/**
 * Whether the metric's best value hasn't improved in the last `stallRounds`
 * rounds it was reported in. The first value is the baseline: a metric that
 * stays flat from the start stalls after `stallRounds` values.
 */
export function isStalled(history: RalphRoundMetrics, stallRounds: number): boolean {
  const values = history.values.map((v) => v.value);
  if (stallRounds < 1 || values.length < stallRounds) return false;
  const start = Math.max(values.length - stallRounds, 1);
  let best = values[0]!;
  for (const value of values.slice(1, start)) {
    if (better(history.direction, value, best)) best = value;
  }
  return !values.slice(start).some((value) => better(history.direction, value, best));
}

/** E.g. `critique score (higher is better, target 40): 23 → 26 → 29`. */
export function metricTrend(history: RalphRoundMetrics): string {
  const about = [
    `${history.direction} is better`,
    ...(history.target !== undefined ? [`target ${history.target}`] : []),
  ].join(", ");
  return `${history.name} (${about}): ${history.values.map((v) => v.value).join(" → ")}`;
}
