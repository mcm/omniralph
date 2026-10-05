import type { Finding } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import type { ReviewResult } from "./runReview.js";
import { renderSummary } from "./summary.js";

const finding = (severity: Finding["severity"]): Finding => ({
  path: "src/a.ts",
  startLine: 1,
  endLine: 1,
  severity,
  category: "correctness",
  title: "t",
  body: "b",
  confidence: 0.8,
});

const base: ReviewResult = {
  profile: { id: "standard", name: "Standard" },
  budget: 200_000,
  findings: [finding("high"), finding("medium"), finding("medium"), finding("info")],
  usage: { inputTokens: 41_000, outputTokens: 2_345 },
  skipped: [
    { path: "pnpm-lock.yaml", reason: "excluded" },
    { path: "logo.png", reason: "binary" },
    { path: "src/`odd`.ts", reason: "budget" },
  ],
  stopReason: "completed",
  scope: { mode: "full", baseSha: "a", headSha: "b" },
  discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
};

const url = "https://omniralph.example.com/reviews/r-1";

describe("renderSummary", () => {
  it("renders profile, severity counts, tokens, skipped files and the link", () => {
    expect(renderSummary(base, url)).toMatchSnapshot();
  });

  it("renders a clean review without a table or skipped files", () => {
    const text = renderSummary({ ...base, findings: [], skipped: [] }, url);
    expect(text).toContain("- **Findings:** none");
    expect(text).not.toContain("| Severity |");
    expect(text).not.toContain("Skipped files");
    expect(text.trimEnd().endsWith(`[View the full review](${url})`)).toBe(true);
  });

  it("keeps skipped paths with line breaks on one line", () => {
    const text = renderSummary(
      { ...base, skipped: [{ path: "a\n# Approved\r\nb.ts", reason: "generated" }] },
      url,
    );
    expect(text).toContain("- `a # Approved b.ts`: generated code");
    expect(text).not.toMatch(/^# Approved/m);
  });

  it("warns about partial results and shows the incremental scope", () => {
    const text = renderSummary(
      {
        ...base,
        stopReason: "budget_exhausted",
        usage: { inputTokens: 199_000, outputTokens: 1_500 },
        scope: { mode: "incremental", fromSha: "0123456789abcdef0123", headSha: "x" },
      },
      url,
    );
    expect(text).toContain("> The token budget ran out before the review finished");
    expect(text).toContain("- **Tokens:** 200,500 / 200,000");
    expect(text).toContain("commits since `0123456789ab`");
  });
});
