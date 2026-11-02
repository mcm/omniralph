import { getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  applyFindingVerification,
  findingVerificationContext,
  FindingVerificationOutput,
  isRateLimitError,
  MAX_UNREACHED_AREAS,
  MAX_VERIFICATION_REASON_LENGTH,
  MAX_VERIFICATION_SUMMARY_LENGTH,
  MAX_VERIFIED_FINDINGS,
  verifierRunFromResult,
  type FindingVerdict,
  type VerificationInputFinding,
  type VerifierRun,
} from "./finding-verification.js";
import type { QueryRunResult } from "./run-result.js";

const task = getBuiltinTask("builtin:verify-findings")!;
const jsonSchema = z.fromJSONSchema(task.outputSchema as Parameters<typeof z.fromJSONSchema>[0]);

function finding(id: string, path = "src/app.ts"): VerificationInputFinding {
  return {
    id,
    path,
    startLine: 2,
    endLine: 3,
    severity: "high",
    category: "security",
    title: `Finding ${id}`,
    body: "The token is logged.",
    suggestion: null,
  };
}

function verdict(findingId: string, kind: FindingVerdict["verdict"], line = 2): FindingVerdict {
  return { findingId, verdict: kind, path: "src/app.ts", line, reason: `Line ${line} shows it.` };
}

function answered(output: unknown): VerifierRun {
  return { status: "answered", output };
}

const unreached = {
  path: "src/auth.ts",
  startLine: 10,
  endLine: 20,
  reason: "The new session check wasn't looked at.",
};

describe("FindingVerificationOutput", () => {
  it("accepts what builtin:verify-findings' output schema accepts", () => {
    for (const output of [
      { verdicts: [verdict("a", "confirmed")], unreached: [unreached], summary: "One holds." },
      {
        verdicts: [verdict("a", "rejected")],
        unreached: [{ ...unreached, startLine: null, endLine: null }],
        summary: "",
      },
      { verdicts: [], unreached: [], summary: "Nothing to check." },
    ]) {
      expect(jsonSchema.safeParse(output).success).toBe(true);
      expect(FindingVerificationOutput.safeParse(output).success).toBe(true);
    }
  });

  it("rejects what the output schema rejects", () => {
    for (const output of [
      { verdicts: [], unreached: [] },
      {
        verdicts: [{ ...verdict("a", "confirmed"), verdict: "maybe" }],
        unreached: [],
        summary: "",
      },
      { verdicts: [{ ...verdict("a", "confirmed"), line: 0 }], unreached: [], summary: "" },
      { verdicts: [{ ...verdict("a", "confirmed"), path: "" }], unreached: [], summary: "" },
      { verdicts: [{ ...verdict("a", "confirmed"), reason: "" }], unreached: [], summary: "" },
      { verdicts: [], unreached: [{ ...unreached, reason: undefined }], summary: "" },
      {
        verdicts: [],
        unreached: Array.from({ length: MAX_UNREACHED_AREAS + 1 }, () => unreached),
        summary: "",
      },
      { verdicts: [], unreached: [], summary: "x".repeat(MAX_VERIFICATION_SUMMARY_LENGTH + 1) },
      {
        verdicts: [
          { ...verdict("a", "confirmed"), reason: "x".repeat(MAX_VERIFICATION_REASON_LENGTH + 1) },
        ],
        unreached: [],
        summary: "",
      },
    ]) {
      expect(jsonSchema.safeParse(output).success).toBe(false);
      expect(FindingVerificationOutput.safeParse(output).success).toBe(false);
    }
  });
});

describe("findingVerificationContext", () => {
  const request = {
    reviewRunId: "0f0f0f0f-0000-4000-8000-000000000001",
    repository: "acme/app",
    prNumber: 42,
    checkType: "security",
    pass: 1,
    baseSha: "base",
    headSha: "head",
    files: ["src/app.ts", "src/auth.ts"],
    findings: [{ ...finding("a"), confidence: 0.9 } as VerificationInputFinding],
  };

  it("invokes the verifier for the review run with the pass's files and findings", () => {
    const context = findingVerificationContext(request);
    expect(context.invoker).toEqual({ kind: "review-run", id: request.reviewRunId });
    expect(context.verification.files).toBe("src/app.ts\nsrc/auth.ts");
    // Only the fields the verifier needs.
    expect(context.verification.findings).toEqual([finding("a")]);
  });

  it("sends no file list without files, and at most MAX_VERIFIED_FINDINGS findings", () => {
    const many = Array.from({ length: MAX_VERIFIED_FINDINGS + 5 }, (_, i) => finding(`f-${i}`));
    const context = findingVerificationContext({ ...request, files: [], findings: many });
    expect(context.verification.files).toBeNull();
    expect(context.verification.findings).toHaveLength(MAX_VERIFIED_FINDINGS);
  });
});

describe("applyFindingVerification", () => {
  const findings = [finding("a"), finding("b"), finding("c")];

  it("keeps the findings the verifier confirmed, with the line each relies on", () => {
    const result = applyFindingVerification(
      findings,
      answered({
        verdicts: [
          verdict("a", "confirmed", 2),
          verdict("b", "confirmed", 7),
          verdict("c", "confirmed"),
        ],
        unreached: [unreached],
        summary: "All hold.",
      }),
    );
    expect(result).toEqual({
      status: "verified",
      confirmed: [
        { finding: findings[0], verdict: verdict("a", "confirmed", 2) },
        { finding: findings[1], verdict: verdict("b", "confirmed", 7) },
        { finding: findings[2], verdict: verdict("c", "confirmed") },
      ],
      dropped: { rejected: [], unanswered: [], count: 0 },
      unreached: [unreached],
      summary: "All hold.",
    });
  });

  it("drops and counts the findings it rejected, so they're never posted", () => {
    const result = applyFindingVerification(
      findings,
      answered({
        verdicts: [verdict("a", "rejected"), verdict("b", "confirmed"), verdict("c", "rejected")],
        unreached: [],
        summary: "Two misread the code.",
      }),
    );
    if (result.status !== "verified") throw new Error(result.status);
    expect(result.confirmed.map((c) => c.finding.id)).toEqual(["b"]);
    expect(result.dropped.rejected.map((r) => r.finding.id)).toEqual(["a", "c"]);
    expect(result.dropped.rejected[0]!.verdict).toEqual(verdict("a", "rejected"));
    expect(result.dropped.count).toBe(2);
  });

  it("drops and counts the findings it didn't answer, or answered only by an unknown ID", () => {
    const result = applyFindingVerification(
      findings,
      answered({
        verdicts: [verdict("a", "confirmed"), verdict("nope", "confirmed")],
        unreached: [],
        summary: "",
      }),
    );
    if (result.status !== "verified") throw new Error(result.status);
    expect(result.confirmed.map((c) => c.finding.id)).toEqual(["a"]);
    expect(result.dropped.unanswered.map((f) => f.id)).toEqual(["b", "c"]);
    expect(result.dropped).toMatchObject({ rejected: [], count: 2 });
  });

  it("counts a finding both confirmed and rejected as rejected", () => {
    const result = applyFindingVerification(
      [finding("a")],
      answered({
        verdicts: [
          verdict("a", "confirmed"),
          verdict("a", "rejected", 9),
          verdict("a", "confirmed"),
        ],
        unreached: [],
        summary: "",
      }),
    );
    if (result.status !== "verified") throw new Error(result.status);
    expect(result.confirmed).toEqual([]);
    expect(result.dropped.rejected).toEqual([
      { finding: finding("a"), verdict: verdict("a", "rejected", 9) },
    ]);
  });

  it("drops findings past the ones sent to the verifier, even if it named them", () => {
    const many = Array.from({ length: MAX_VERIFIED_FINDINGS + 1 }, (_, i) => finding(`f-${i}`));
    const result = applyFindingVerification(
      many,
      answered({
        verdicts: many.map((f) => verdict(f.id, "confirmed")),
        unreached: [],
        summary: "",
      }),
    );
    if (result.status !== "verified") throw new Error(result.status);
    expect(result.confirmed).toHaveLength(MAX_VERIFIED_FINDINGS);
    expect(result.dropped.unanswered.map((f) => f.id)).toEqual([`f-${MAX_VERIFIED_FINDINGS}`]);
  });

  it("keeps the findings unverified with a warning when the answer is malformed", () => {
    const warn = vi.fn();
    for (const output of [
      null,
      "confirmed",
      { verdicts: [verdict("a", "confirmed")], summary: "" },
      { verdicts: [{ ...verdict("a", "confirmed"), line: "two" }], unreached: [], summary: "" },
    ]) {
      const result = applyFindingVerification(findings, answered(output), { warn });
      expect(result).toMatchObject({ status: "unverified", findings });
      if (result.status !== "unverified") throw new Error(result.status);
      expect(result.warning).toMatch(/^The verifier's answer is malformed/);
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenLastCalledWith(expect.stringMatching(/malformed/), { findings: 3 });
  });

  it("keeps the findings unverified with a warning when the verifier failed", () => {
    const warn = vi.fn();
    const result = applyFindingVerification(
      findings,
      { status: "failed", error: "the query session failed", rateLimited: false },
      { warn },
    );
    expect(result).toEqual({
      status: "unverified",
      findings,
      warning:
        "The verifier failed, so the pass's findings are kept unverified: the query session failed",
    });
    expect(warn).toHaveBeenCalledWith(result.status === "unverified" && result.warning, {
      findings: 3,
    });
  });

  it("retries a verifier that hit a rate limit, applying nothing yet", () => {
    const warn = vi.fn();
    expect(
      applyFindingVerification(
        findings,
        { status: "failed", error: "Claude rate limit reached", rateLimited: true },
        { warn },
      ),
    ).toEqual({ status: "retry" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs to console.warn by default", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyFindingVerification(findings, { status: "failed", error: null, rateLimited: false });
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/unknown error$/), { findings: 3 });
    spy.mockRestore();
  });
});

describe("verifierRunFromResult", () => {
  const base = {
    answer: null,
    references: [],
    usage: {} as QueryRunResult["usage"],
    durationMs: 1,
  };

  it("reads an answered run's output, and anything else as a failure", () => {
    const output = { verdicts: [], unreached: [], summary: "" };
    expect(verifierRunFromResult({ ...base, outcome: "answered", structured: output })).toEqual({
      status: "answered",
      output,
    });
    expect(
      verifierRunFromResult({ ...base, outcome: "budget_exhausted", structured: null }),
    ).toEqual({
      status: "failed",
      error: "The verifier didn't answer (budget_exhausted)",
      rateLimited: false,
    });
  });
});

describe("isRateLimitError", () => {
  it("recognizes the agent's rate limit errors", () => {
    expect(isRateLimitError("Claude rate limit: usage limit reached")).toBe(true);
    expect(isRateLimitError("HTTP 429 Too Many Requests")).toBe(true);
    expect(isRateLimitError("the query session failed")).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});
