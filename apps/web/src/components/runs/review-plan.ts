/**
 * Pure helpers of a looped review's Plan card: the check types' names and states, each
 * pass's counts and the review's totals.
 */
import type { StatusTone } from "@omniralph/ui";
import type { ReviewCheck, ReviewCheckPass, RunStep } from "@/lib/api/runs";

type ReviewPassStep = Extract<RunStep, { kind: "review_pass" }>;

/** A review pass step that is one check type of a looped review. */
export type ReviewCheckStep = ReviewPassStep & { check: ReviewCheck };

export const REVIEW_CHECK_LABELS: Record<ReviewCheck["type"], string> = {
  security: "Security",
  stability: "Stability",
  performance: "Performance",
  compatibility: "Compatibility",
  maintainability: "Maintainability",
};

/** The run's check type steps, in step order; none for a single-pass review. */
export function reviewCheckSteps(steps: readonly RunStep[]): ReviewCheckStep[] {
  return steps.filter(
    (step): step is ReviewCheckStep => step.kind === "review_pass" && step.check !== null,
  );
}

/** A check type's state word and its dot's tone. */
export function checkState(status: ReviewPassStep["status"]): { text: string; tone: StatusTone } {
  switch (status) {
    case "queued":
      return { text: "Queued", tone: "neutral" };
    case "running":
      return { text: "Running", tone: "run" };
    case "completed":
      return { text: "Done", tone: "good" };
    case "budget_exhausted":
      return { text: "Out of budget", tone: "warn" };
    case "failed":
      return { text: "Failed", tone: "fail" };
    case "skipped":
      return { text: "Skipped", tone: "neutral" };
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 file", "12 files". */
export function filesText(n: number): string {
  return count(n, "file", "files");
}

/** A pass's counts: "2 new · 3 confirmed · 1 dropped by verification". */
export function passCounts(pass: Pick<ReviewCheckPass, "new" | "confirmed" | "dropped">): string {
  return `${pass.new} new · ${pass.confirmed} confirmed · ${pass.dropped} dropped by verification`;
}

/** What the pass running now is doing: "Reviewing", "Verifying its findings". */
export function currentPassText(current: NonNullable<ReviewCheck["current"]>): string {
  return current.phase === "reviewing" ? "Reviewing" : "Verifying its findings";
}

export interface ReviewPlanTotals {
  checkTypes: number;
  /** Distinct files over every check type. */
  files: number;
  /** Findings verification kept (each check type's new ones, so none counts twice). */
  confirmed: number;
  /** Findings verification dropped: never posted. */
  dropped: number;
}

/** The review's totals over its check types, so far. */
export function reviewPlanTotals(steps: readonly ReviewCheckStep[]): ReviewPlanTotals {
  const files = new Set(steps.flatMap((step) => step.check.files));
  let confirmed = 0;
  let dropped = 0;
  for (const { check } of steps) {
    confirmed += check.passes.reduce((sum, pass) => sum + pass.new, 0);
    dropped += check.droppedFindings;
  }
  return { checkTypes: steps.length, files: files.size, confirmed, dropped };
}

/**
 * The totals line: "4 check types over 23 files: 7 confirmed findings, 3 dropped by
 * verification."
 */
export function totalsText(totals: ReviewPlanTotals): string {
  return (
    `${count(totals.checkTypes, "check type", "check types")} over ${filesText(totals.files)}: ` +
    `${count(totals.confirmed, "confirmed finding", "confirmed findings")}, ` +
    `${totals.dropped} dropped by verification.`
  );
}
