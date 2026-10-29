import { progressSummary } from "@omniralph/ui";
import { describe, expect, it } from "vitest";
import { stepsToProgress } from "@/components/runs/progress";
import type { RunStep } from "@/lib/api/runs";
import { settleFailedTurn } from "./turns";

type Attempt = { id: string; status: RunStep["status"]; error: string | null };

const MINUTE = 60_000;

/** A triage's turns as its progress card draws them (attempts are newest first). */
function progress(attempts: readonly Attempt[], status: "failed" | "completed") {
  const steps: RunStep[] = settleFailedTurn(attempts, status)
    .toReversed()
    .map((a) => ({
      kind: "attempt",
      id: a.id,
      label: a.id,
      status: a.status as Extract<RunStep, { kind: "attempt" }>["status"],
      durationMs: 9 * MINUTE,
    }));
  const { steps: drawn, summarySuffix } = stepsToProgress(steps);
  return { states: drawn.map((s) => s.state), summary: progressSummary(drawn, summarySuffix) };
}

describe("a failed run's last turn", () => {
  it("reads failed when the run failed after its job completed", () => {
    expect(progress([{ id: "t1", status: "completed", error: null }], "failed")).toEqual({
      states: ["failed"],
      summary: "0 of 1 done · 1 failed · 9m",
    });
  });

  it("carries the run's error when its completed job reported none", () => {
    const attempts: Attempt[] = [{ id: "t1", status: "completed", error: null }];
    expect(settleFailedTurn(attempts, "failed", "Linear refused the update")).toEqual([
      { id: "t1", status: "failed", error: "Linear refused the update" },
    ]);
  });

  it("reads failed, with the job's error, when the job failed", () => {
    const attempts: Attempt[] = [{ id: "t1", status: "failed", error: "max_turns" }];
    expect(settleFailedTurn(attempts, "failed", "the run's")).toEqual(attempts);
    expect(progress(attempts, "failed")).toEqual({
      states: ["failed"],
      summary: "0 of 1 done · 1 failed · 9m",
    });
  });

  it("keeps earlier turns done: only the newest is what failed", () => {
    const attempts: Attempt[] = [
      { id: "reply", status: "completed", error: null },
      { id: "first", status: "completed", error: null },
    ];
    expect(progress(attempts, "failed").states).toEqual(["done", "failed"]);
  });

  it("leaves a completed run's turns done", () => {
    expect(progress([{ id: "t1", status: "completed", error: null }], "completed")).toEqual({
      states: ["done"],
      summary: "1 of 1 done · 9m",
    });
  });
});
