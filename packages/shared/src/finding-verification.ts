/**
 * Finding verification: after a review pass, the review run invokes its
 * finding verifier (`builtin:verify-findings`, role `verifier`, trigger
 * `run.invoked`) in a read-only checkout of the head with the pass's
 * findings. A fresh session that never saw the pass's reasoning confirms or
 * rejects each finding, citing the line it relies on, and names the areas of
 * the change the pass didn't reach. `applyFindingVerification` turns its run
 * into what the review keeps: confirmed findings are kept, rejected and
 * unanswered ones are dropped and counted (never posted), and a verifier that
 * failed keeps the pass's findings unverified with a warning, unless it hit a
 * rate limit, which retries.
 */
import { z } from "zod";
import { FindingSeverity } from "./finding.js";
import type { QueryRunResult } from "./run-result.js";

/** Job type of a review pass's finding verification run. */
export const FINDING_VERIFICATION_JOB_TYPE = "review.verify-findings";

/** Most findings one verification checks (a pass's findings beyond it are dropped as unanswered). */
export const MAX_VERIFIED_FINDINGS = 100;
/** Most areas a verifier may name that the pass didn't reach. */
export const MAX_UNREACHED_AREAS = 50;
/** Longest reason a verifier may give for a verdict or an unreached area. */
export const MAX_VERIFICATION_REASON_LENGTH = 2_000;
/** Longest summary a verifier may write. */
export const MAX_VERIFICATION_SUMMARY_LENGTH = 5_000;

/** A finding of the pass, as the verifier sees it. */
export const VerificationInputFinding = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  severity: FindingSeverity,
  category: z.string().min(1),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
});
export type VerificationInputFinding = z.infer<typeof VerificationInputFinding>;

/**
 * The `run.invoked` trigger context of a finding verification: the invoking
 * review run, its PR, the commits of the change (the checkout is of
 * `headSha`), the pass's check type and number, the files it reviewed (one
 * per line) and its findings.
 */
export const FindingVerificationTriggerContext = z.object({
  invoker: z.object({ kind: z.literal("review-run"), id: z.uuid() }),
  repository: z.string().min(1),
  pr: z.object({ number: z.int() }),
  verification: z.object({
    checkType: z.string().min(1),
    pass: z.int().min(1),
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    files: z.string().nullable(),
    findings: z.array(VerificationInputFinding).max(MAX_VERIFIED_FINDINGS),
  }),
});
export type FindingVerificationTriggerContext = z.infer<typeof FindingVerificationTriggerContext>;

/** What `findingVerificationContext` builds a verification's trigger context from. */
export interface FindingVerificationRequest {
  reviewRunId: string;
  repository: string;
  prNumber: number;
  checkType: string;
  pass: number;
  baseSha: string;
  headSha: string;
  /** The files the pass reviewed. */
  files: readonly string[];
  findings: readonly VerificationInputFinding[];
}

/**
 * The trigger context of a pass's verification. Only its first
 * `MAX_VERIFIED_FINDINGS` findings are sent: the rest go unanswered, so
 * `applyFindingVerification` drops them.
 */
export function findingVerificationContext(
  request: FindingVerificationRequest,
): FindingVerificationTriggerContext {
  return FindingVerificationTriggerContext.parse({
    invoker: { kind: "review-run", id: request.reviewRunId },
    repository: request.repository,
    pr: { number: request.prNumber },
    verification: {
      checkType: request.checkType,
      pass: request.pass,
      baseSha: request.baseSha,
      headSha: request.headSha,
      files: request.files.length > 0 ? request.files.join("\n") : null,
      findings: request.findings.slice(0, MAX_VERIFIED_FINDINGS).map((finding) => ({
        id: finding.id,
        path: finding.path,
        startLine: finding.startLine,
        endLine: finding.endLine,
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
        body: finding.body,
        suggestion: finding.suggestion,
      })),
    },
  });
}

export const FINDING_VERDICTS = ["confirmed", "rejected"] as const;
export type FindingVerdictKind = (typeof FINDING_VERDICTS)[number];

/** The verifier's verdict on one finding, with the line of code it relies on. */
export const FindingVerdict = z.object({
  findingId: z.string().min(1),
  verdict: z.enum(FINDING_VERDICTS),
  /** File of the line the verdict relies on (at the head). */
  path: z.string().min(1),
  /** The line the verdict relies on (1-based, at the head). */
  line: z.int().min(1),
  reason: z.string().trim().min(1).max(MAX_VERIFICATION_REASON_LENGTH),
});
export type FindingVerdict = z.infer<typeof FindingVerdict>;

/** An area of the change the pass didn't reach, for the next pass to cover. */
export const UnreachedArea = z.object({
  path: z.string().min(1),
  startLine: z.int().min(1).nullable(),
  endLine: z.int().min(1).nullable(),
  reason: z.string().trim().min(1).max(MAX_VERIFICATION_REASON_LENGTH),
});
export type UnreachedArea = z.infer<typeof UnreachedArea>;

/** The structured output of a finding verification (`builtin:verify-findings`'s fixed output schema). */
export const FindingVerificationOutput = z.object({
  verdicts: z.array(FindingVerdict).max(MAX_VERIFIED_FINDINGS * 2),
  unreached: z.array(UnreachedArea).max(MAX_UNREACHED_AREAS),
  summary: z.string().max(MAX_VERIFICATION_SUMMARY_LENGTH),
});
export type FindingVerificationOutput = z.infer<typeof FindingVerificationOutput>;

/** How a verifier run ended, as `applyFindingVerification` reads it. */
export type VerifierRun =
  | { status: "answered"; output: unknown }
  /**
   * The run failed, finished without an answer, or was canceled.
   * `rateLimited`: it stopped on a rate limit and is retried.
   */
  | { status: "failed"; error: string | null; rateLimited: boolean };

/** Text of an error that a rate limit caused (as the agent's sessions report them). */
const RATE_LIMIT_TEXT = /rate[_ ]limit|usage limit|\b429\b|too many requests/i;

/** Whether `error` says the run stopped on a Claude rate limit. */
export function isRateLimitError(error: string | null | undefined): boolean {
  return error != null && RATE_LIMIT_TEXT.test(error);
}

/** A finished verifier query run as a `VerifierRun`: anything but an answer is a failure. */
export function verifierRunFromResult(result: QueryRunResult): VerifierRun {
  return result.outcome === "answered"
    ? { status: "answered", output: result.structured }
    : {
        status: "failed",
        error: `The verifier didn't answer (${result.outcome})`,
        rateLimited: false,
      };
}

/** A finding the verifier confirmed, with the verdict that confirmed it. */
export interface ConfirmedFinding<F> {
  finding: F;
  verdict: FindingVerdict;
}

/** Findings verification dropped: never posted, only counted. */
export interface DroppedFindings<F> {
  /** Findings the verifier rejected, with its verdicts. */
  rejected: { finding: F; verdict: FindingVerdict }[];
  /** Findings the verifier gave no usable verdict for. */
  unanswered: F[];
  /** `rejected.length + unanswered.length`. */
  count: number;
}

/** What a pass keeps after its verification. */
export type FindingVerification<F> =
  /** The verifier answered: only confirmed findings are kept. */
  | {
      status: "verified";
      confirmed: ConfirmedFinding<F>[];
      dropped: DroppedFindings<F>;
      unreached: UnreachedArea[];
      summary: string;
    }
  /** The verifier failed (or its answer was malformed): the pass's findings are kept unverified. */
  | { status: "unverified"; findings: F[]; warning: string }
  /** The verifier hit a rate limit: it runs again, and nothing is applied yet. */
  | { status: "retry" };

export interface ApplyVerificationOptions {
  /** Where the warning of an unverified pass is logged (default `console.warn`). */
  warn?: (message: string, details: Record<string, unknown>) => void;
}

/**
 * What a pass keeps of `findings` after its verifier `run`:
 * - an answer keeps the findings it confirmed; those it rejected, and those
 *   it gave no verdict for (or only a verdict naming another finding), are
 *   dropped and counted. A finding with both verdicts counts as rejected.
 * - an answer that isn't a `FindingVerificationOutput`, or a failed run,
 *   keeps every finding unverified and logs a warning.
 * - a rate-limited run is retried: nothing is kept or dropped yet.
 */
export function applyFindingVerification<F extends { id: string }>(
  findings: readonly F[],
  run: VerifierRun,
  options: ApplyVerificationOptions = {},
): FindingVerification<F> {
  if (run.status === "failed" && run.rateLimited) return { status: "retry" };
  const output = run.status === "answered" ? FindingVerificationOutput.safeParse(run.output) : null;
  if (!output?.success) {
    const warning = output
      ? `The verifier's answer is malformed, so the pass's findings are kept unverified: ${z.prettifyError(output.error).slice(0, 2_000)}`
      : `The verifier failed, so the pass's findings are kept unverified: ${run.status === "failed" ? (run.error ?? "unknown error") : "no answer"}`;
    (options.warn ?? console.warn)(warning, { findings: findings.length });
    return { status: "unverified", findings: [...findings], warning };
  }

  const byId = new Map<string, FindingVerdict>();
  for (const verdict of output.data.verdicts) {
    const earlier = byId.get(verdict.findingId);
    // A rejection wins over a confirmation of the same finding.
    if (!earlier || (earlier.verdict === "confirmed" && verdict.verdict === "rejected")) {
      byId.set(verdict.findingId, verdict);
    }
  }
  const confirmed: ConfirmedFinding<F>[] = [];
  const rejected: DroppedFindings<F>["rejected"] = [];
  const unanswered: F[] = [];
  findings.forEach((finding, index) => {
    // Findings past the limit weren't sent to the verifier, whatever it answered.
    const verdict = index < MAX_VERIFIED_FINDINGS ? byId.get(finding.id) : undefined;
    if (!verdict) unanswered.push(finding);
    else if (verdict.verdict === "confirmed") confirmed.push({ finding, verdict });
    else rejected.push({ finding, verdict });
  });
  return {
    status: "verified",
    confirmed,
    dropped: { rejected, unanswered, count: rejected.length + unanswered.length },
    unreached: output.data.unreached,
    summary: output.data.summary,
  };
}
