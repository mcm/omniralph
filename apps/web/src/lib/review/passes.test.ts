import type { Finding, ReviewTaskResult, VerifierRun } from "@omniralph/shared";
import { describe, expect, it, vi } from "vitest";
import {
  nextPassContext,
  passConverged,
  passFindingId,
  settlePasses,
  unreachedText,
  type PassInput,
} from "./passes";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: "src/app.ts",
  startLine: 3,
  endLine: 3,
  severity: "high",
  category: "security",
  title: "Token logged",
  body: "The token is written to the log.",
  confidence: 0.9,
  ...overrides,
});

const result = (findings: Finding[], files = ["src/app.ts"]): ReviewTaskResult => ({
  findings,
  usage: { inputTokens: 100, outputTokens: 10 },
  skipped: [],
  stopReason: "completed",
  scope: { mode: "full", baseSha: "a".repeat(40), headSha: "b".repeat(40) },
  discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
  durationMs: 1,
  pass: { checkType: "security", files },
});

const verdict = (
  findingId: string,
  kind: "confirmed" | "rejected",
  reason = "Line 3 logs it.",
) => ({ findingId, verdict: kind, path: "src/app.ts", line: 3, reason });

const answered = (
  verdicts: ReturnType<typeof verdict>[],
  unreached: {
    path: string;
    startLine: number | null;
    endLine: number | null;
    reason: string;
  }[] = [],
): VerifierRun => ({ status: "answered", output: { verdicts, unreached, summary: "Checked." } });

const pass = (number: number, findings: Finding[], verifier: VerifierRun | null): PassInput => ({
  number,
  result: result(findings),
  verifier,
});

const quiet = { warn: vi.fn() };

describe("settlePasses", () => {
  it("keeps only the findings the verifier confirmed and counts the rest as dropped", () => {
    const logged = finding();
    const injected = finding({ startLine: 9, endLine: 9, title: "SQL injection" });
    const unanswered = finding({ startLine: 20, endLine: 20, title: "Weak hash" });
    const settled = settlePasses(
      [
        pass(
          1,
          [logged, injected, unanswered],
          answered([
            verdict(passFindingId(1, 0), "confirmed"),
            verdict(passFindingId(1, 1), "rejected", "The input is a constant."),
          ]),
        ),
      ],
      quiet,
    );
    expect(settled.findings).toEqual([logged]);
    expect(settled.dropped).toBe(2);
    expect(settled.passes[0]!.record).toEqual({
      number: 1,
      files: ["src/app.ts"],
      reported: 3,
      confirmed: 1,
      new: 1,
      dropped: 2,
      verification: "verified",
      unreached: 0,
      summary: "Checked.",
    });
  });

  it("drops a security finding the verifier rejects for not explaining how it could be exploited", () => {
    const vague = finding({ body: "This looks unsafe." });
    const settled = settlePasses(
      [
        pass(
          1,
          [vague],
          answered([verdict("p1-1", "rejected", "It doesn't say how this could be exploited.")]),
        ),
      ],
      quiet,
    );
    expect(settled.findings).toEqual([]);
    expect(settled.dropped).toBe(1);
  });

  it("counts as new only the confirmed findings no earlier pass confirmed", () => {
    const first = finding();
    const again = finding({ title: "Token logged (again)" });
    const other = finding({ path: "src/db.ts", title: "Query built from input" });
    const settled = settlePasses(
      [
        pass(1, [first], answered([verdict("p1-1", "confirmed")])),
        pass(
          2,
          [again, other],
          answered([verdict("p2-1", "confirmed"), verdict("p2-2", "confirmed")]),
        ),
      ],
      quiet,
    );
    expect(settled.passes.map((p) => [p.record.confirmed, p.record.new])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(settled.findings).toEqual([first, other]);
  });

  it("keeps a pass's findings unverified when its verifier failed, even on a rate limit", () => {
    const kept = finding();
    const settled = settlePasses(
      [pass(1, [kept], { status: "failed", error: "429 rate limit", rateLimited: true })],
      quiet,
    );
    expect(settled.findings).toEqual([kept]);
    expect(settled.dropped).toBe(0);
    expect(settled.passes[0]!.record).toMatchObject({ verification: "unverified", confirmed: 1 });
    expect(quiet.warn).toHaveBeenCalled();
  });

  it("needs no verifier for a pass that reported nothing", () => {
    const settled = settlePasses([pass(1, [], null)]);
    expect(settled.passes[0]!.record).toMatchObject({
      reported: 0,
      confirmed: 0,
      new: 0,
      verification: "verified",
    });
  });
});

describe("passConverged", () => {
  const settled = (newFindings: number, number: number) => ({
    number,
    fresh: Array.from({ length: newFindings }, () => finding()),
  });

  it("stops once a pass adds no newly confirmed finding", () => {
    expect(passConverged(settled(0, 1), { minPasses: 1 })).toBe(true);
    expect(passConverged(settled(2, 1), { minPasses: 1 })).toBe(false);
    expect(passConverged(settled(0, 2), { minPasses: 1 })).toBe(true);
  });

  it("never stops before the check type's minimum passes (security at Deep)", () => {
    expect(passConverged(settled(0, 1), { minPasses: 2 })).toBe(false);
    expect(passConverged(settled(0, 2), { minPasses: 2 })).toBe(true);
  });
});

describe("nextPassContext", () => {
  it("gives the next pass what was confirmed so far and what the last pass didn't reach", () => {
    const first = finding();
    const settled = settlePasses(
      [
        pass(
          1,
          [first],
          answered(
            [verdict("p1-1", "confirmed")],
            [
              {
                path: "src/db.ts",
                startLine: 4,
                endLine: null,
                reason: "The query isn't checked.",
              },
              { path: "src/cache.ts", startLine: null, endLine: null, reason: "Not read." },
            ],
          ),
        ),
      ],
      quiet,
    );
    expect(nextPassContext("security", settled)).toEqual({
      checkType: "security",
      number: 2,
      confirmed: [
        {
          path: "src/app.ts",
          startLine: 3,
          endLine: 3,
          severity: "high",
          category: "security",
          title: "Token logged",
        },
      ],
      unreached: [
        { path: "src/db.ts", startLine: 4, endLine: 4, reason: "The query isn't checked." },
        { path: "src/cache.ts", startLine: null, endLine: null, reason: "Not read." },
      ],
    });
  });
});

describe("unreachedText", () => {
  it("names the area's file and lines", () => {
    expect(unreachedText({ path: "a.ts", startLine: 3, endLine: 9, reason: "Check it." })).toBe(
      "a.ts:3-9: Check it.",
    );
    expect(unreachedText({ path: "a.ts", startLine: null, endLine: null, reason: "All." })).toBe(
      "a.ts: All.",
    );
  });
});
