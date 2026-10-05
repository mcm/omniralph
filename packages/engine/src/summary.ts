import { FINDING_SEVERITIES } from "@omniralph/shared";
import type { SkipReason } from "./plan.js";
import type { ReviewResult } from "./runReview.js";

const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  excluded: "excluded by path filters",
  generated: "generated code",
  binary: "binary file",
  no_changes: "no line changes",
  budget: "over the token budget",
  max_files: "over the profile's file limit",
};

const STOP_NOTES: Record<ReviewResult["stopReason"], string | undefined> = {
  completed: undefined,
  budget_exhausted:
    "The token budget ran out before the review finished; the findings below are partial.",
  rate_limited: "The review hit a Claude rate limit before finishing; the findings are partial.",
  error: "The review stopped with an error before finishing; the findings are partial.",
};

const number = new Intl.NumberFormat("en-US");

/** Inline code that survives backticks and line breaks in the content. */
function code(raw: string): string {
  const text = raw.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${marks}${pad}${text}${pad}${marks}`;
}

/**
 * The PR/MR summary comment: profile, findings by severity, tokens used vs.
 * budget, skipped files with reasons and a link to the review page.
 */
export function renderSummary(result: ReviewResult, reviewUrl: string): string {
  const counts = FINDING_SEVERITIES.map(
    (severity) =>
      [severity, result.findings.filter((f) => f.severity === severity).length] as const,
  );
  const total = result.findings.length;
  const used = result.usage.inputTokens + result.usage.outputTokens;

  const lines = ["## Omniralph review", ""];
  const note = STOP_NOTES[result.stopReason];
  if (note) lines.push(`> [!WARNING]`, `> ${note}`, "");

  lines.push(
    `- **Profile:** ${result.profile.name}`,
    `- **Findings:** ${total === 0 ? "none" : total}`,
    `- **Tokens:** ${number.format(used)} / ${number.format(result.budget)}`,
  );
  if (result.scope.mode === "incremental") {
    lines.push(
      `- **Scope:** commits since ${code(result.scope.fromSha.slice(0, 12))} (incremental review)`,
    );
  }
  lines.push("");

  if (total > 0) {
    lines.push("| Severity | Count |", "| --- | ---: |");
    for (const [severity, count] of counts) lines.push(`| ${severity} | ${count} |`);
    lines.push("");
  }

  if (result.skipped.length > 0) {
    lines.push(
      "<details>",
      `<summary>Skipped files (${result.skipped.length})</summary>`,
      "",
      ...result.skipped.map((s) => `- ${code(s.path)}: ${SKIP_REASON_LABELS[s.reason]}`),
      "",
      "</details>",
      "",
    );
  }

  lines.push(`[View the full review](${reviewUrl})`);
  return `${lines.join("\n")}\n`;
}
