import { sameIssue } from "@omniralph/engine/same-issue";
import {
  applyFindingVerification,
  MAX_PASS_CONFIRMED_FINDINGS,
  MAX_PASS_UNREACHED_AREAS,
  type ApplyVerificationOptions,
  type Finding,
  type ReviewPassContext,
  type ReviewPassLimits,
  type ReviewPassRecord,
  type ReviewTaskResult,
  type UnreachedArea,
  type VerifierRun,
} from "@omniralph/shared";

/**
 * The passes of a looped review's check type (one `reviews` row): each pass
 * is a review task run over the check type's files, then (when it reported
 * findings) a verifier run of `builtin:verify-findings` that confirms or
 * rejects each finding and names the areas the pass didn't reach. Only
 * confirmed findings count; rejected and unanswered ones are dropped and
 * counted, never posted. A pass whose verifier failed keeps its findings
 * unverified. The check type stops once a pass adds no newly confirmed
 * finding (and it ran its minimum), or at its depth's pass cap.
 */

/** One pass as its jobs left it. */
export interface PassInput {
  /** 1 for the first pass. */
  number: number;
  /** The pass's review task result. */
  result: ReviewTaskResult;
  /**
   * How its verifier run ended; null when no verifier ran (the pass reported
   * nothing, or the review's depth doesn't verify findings).
   */
  verifier: VerifierRun | null;
}

/** What a pass kept, after its verification. */
export interface SettledPass {
  number: number;
  record: ReviewPassRecord;
  /** The findings it keeps (confirmed, or every finding of an unverified pass). */
  kept: Finding[];
  /** The kept findings no earlier pass kept (`sameIssue`). */
  fresh: Finding[];
  /** The areas its verifier said it didn't reach. */
  unreached: UnreachedArea[];
}

/** What every pass so far keeps together. */
export interface SettledPasses {
  passes: SettledPass[];
  /** Kept findings of every pass, without repeats of an earlier pass's, first pass first. */
  findings: Finding[];
  /** Findings verification dropped over all passes. */
  dropped: number;
}

/** The ID a pass's finding has for its verifier: its pass and position. */
export function passFindingId(pass: number, index: number): string {
  return `p${pass}-${index + 1}`;
}

/** The findings of a pass with the IDs its verifier sees. */
export function passFindings(
  pass: Pick<PassInput, "number" | "result">,
): (Finding & { id: string })[] {
  return pass.result.findings.map((finding, index) => ({
    ...finding,
    id: passFindingId(pass.number, index),
  }));
}

/**
 * Settles each pass in order: its verification (`applyFindingVerification`;
 * a rate-limited verifier that ended counts as failed, so its findings stay
 * unverified) and the kept findings that are new against every earlier pass.
 */
export function settlePasses(
  inputs: readonly PassInput[],
  options: ApplyVerificationOptions = {},
): SettledPasses {
  const passes: SettledPass[] = [];
  const findings: Finding[] = [];
  let dropped = 0;
  for (const input of inputs) {
    const reported = passFindings(input);
    const verification = input.verifier
      ? applyFindingVerification(
          reported,
          input.verifier.status === "failed"
            ? { ...input.verifier, rateLimited: false }
            : input.verifier,
          options,
        )
      : null;
    const verified = verification?.status === "verified";
    const kept = (
      verification?.status === "verified" ? verification.confirmed.map((c) => c.finding) : reported
    ).map(({ id: _id, ...finding }) => finding);
    const fresh = kept.filter((finding) => !findings.some((prior) => sameIssue(prior, finding)));
    const passDropped = verification?.status === "verified" ? verification.dropped.count : 0;
    const unreached = verification?.status === "verified" ? verification.unreached : [];
    dropped += passDropped;
    findings.push(...fresh);
    passes.push({
      number: input.number,
      kept,
      fresh,
      unreached,
      record: {
        number: input.number,
        files: input.result.pass?.files ?? [],
        reported: reported.length,
        confirmed: kept.length,
        new: fresh.length,
        dropped: passDropped,
        verification: verified || reported.length === 0 ? "verified" : "unverified",
        unreached: unreached.length,
        summary: verification?.status === "verified" ? verification.summary || null : null,
      },
    });
  }
  return { passes, findings, dropped };
}

/**
 * Whether a check type stops after `pass`: once a pass adds no newly
 * confirmed finding, and it ran at least `minPasses` passes (security at
 * Deep runs two). The depth's pass cap (`maxPasses`) is the loop's
 * `maxIterations`, which the loop driver enforces.
 */
export function passConverged(
  pass: Pick<SettledPass, "number" | "fresh">,
  limits: Pick<ReviewPassLimits, "minPasses">,
): boolean {
  return pass.fresh.length === 0 && pass.number >= limits.minPasses;
}

/**
 * The next pass's context: what every pass so far confirmed (in the order
 * they confirmed it, capped) and what the last one didn't reach.
 */
export function nextPassContext(
  checkType: ReviewPassContext["checkType"],
  settled: SettledPasses,
): ReviewPassContext {
  const last = settled.passes.at(-1);
  return {
    checkType,
    number: (last?.number ?? 0) + 1,
    confirmed: settled.findings.slice(0, MAX_PASS_CONFIRMED_FINDINGS).map((finding) => ({
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
    })),
    unreached: (last?.unreached ?? []).slice(0, MAX_PASS_UNREACHED_AREAS).map((area) => ({
      path: area.path,
      startLine: area.startLine,
      endLine: area.startLine === null ? null : (area.endLine ?? area.startLine),
      reason: area.reason,
    })),
  };
}

/** An unreached area as the loop's iteration records it (`path:lines: reason`). */
export function unreachedText(area: UnreachedArea): string {
  const lines =
    area.startLine === null
      ? ""
      : `:${area.startLine}${area.endLine !== null && area.endLine !== area.startLine ? `-${area.endLine}` : ""}`;
  return `${area.path}${lines}: ${area.reason}`;
}
