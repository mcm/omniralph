"use client";

import { Card, StatusDot, type HeadingLevel, type StatusTone } from "@omniralph/ui";
import type { RunDetail, RunIterationView } from "@/lib/api/runs";
import "./loop-views.css";

/** An iteration's state word and its dot's tone. */
export function iterationState(iteration: RunIterationView): { text: string; tone: StatusTone } {
  switch (iteration.status) {
    case "working":
      return { text: "Working", tone: "run" };
    case "verifying":
      return { text: "Verifying", tone: "run" };
    case "failed":
      return { text: "Failed", tone: "fail" };
    case "done":
      return iteration.verdict === "converged"
        ? { text: "Converged", tone: "good" }
        : { text: "Sent back", tone: "warn" };
  }
}

/** A metric as the iteration shows it: "coverage 82 (higher is better, target 90)". */
export function metricText(metric: NonNullable<RunIterationView["metric"]>): string {
  const facts = [`${metric.direction} is better`];
  if (metric.target !== undefined) facts.push(`target ${metric.target}`);
  return `${metric.name} ${metric.value} (${facts.join(", ")})`;
}

/** How the loop ended, from its last iteration's outcome; null while it runs. */
export function loopEnding(iterations: readonly RunIterationView[]): string | null {
  const last = iterations.at(-1);
  if (!last?.outcome) return null;
  switch (last.outcome) {
    case "converged":
      return `The verifier was satisfied after ${iterationCount(last.number)}.`;
    case "max-iterations":
      return `It stopped after ${iterationCount(last.maxIterations)}, its limit, before the verifier was satisfied.`;
    case "stalled":
      return `It stopped after ${iterationCount(last.number)}: the metric stopped improving.`;
    case "failed":
      return `It stopped after ${iterationCount(last.number)}: the last one failed.`;
  }
}

const iterationCount = (n: number) => (n === 1 ? "1 iteration" : `${n} iterations`);

export interface RunIterationsProps {
  run: Pick<RunDetail, "iterations">;
  headingLevel?: HeadingLevel;
}

/**
 * A looped run's iterations, in order: each one's state (working, verifying, converged, sent
 * back or failed), the verifier's summary, its metric, what it sent back for the next
 * iteration or why it failed; then how the loop ended. Nothing for a run that doesn't loop.
 */
export function RunIterations({ run, headingLevel = 3 }: RunIterationsProps) {
  const { iterations } = run;
  if (iterations.length === 0) return null;
  const ending = loopEnding(iterations);
  const max = iterations.at(-1)!.maxIterations;
  return (
    <Card title="Iterations" headingLevel={headingLevel} className="or-iterations">
      <ol className="or-verdict__items" aria-label="Iterations">
        {iterations.map((iteration) => {
          const state = iterationState(iteration);
          return (
            <li key={iteration.id} className="or-verdict__item">
              <StatusDot tone={state.tone} label={state.text} />
              <div className="or-verdict__body">
                <p className="or-verdict__name">
                  Iteration {iteration.number} of {max}
                  <span className="or-verdict__state">{state.text}</span>
                </p>
                {iteration.summary ? <p className="or-verdict__text">{iteration.summary}</p> : null}
                {iteration.metric ? (
                  <p className="or-verdict__text">
                    <span className="or-verdict__label">Metric: </span>
                    <span className="or-mono">{metricText(iteration.metric)}</span>
                  </p>
                ) : null}
                {iteration.error ? <p className="or-verdict__text">{iteration.error}</p> : null}
                {iteration.verdict === "continue" && iteration.findings.length > 0 ? (
                  <div className="or-verdict__text">
                    <span className="or-verdict__label">Sent back</span>
                    <ul className="or-verdict__findings">
                      {iteration.findings.map((finding, index) => (
                        <li key={index}>{finding}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {ending ? <p className="or-iterations__ending">{ending}</p> : null}
    </Card>
  );
}
