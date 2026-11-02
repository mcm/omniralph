import { z } from "zod";
import {
  EVAL_STRATEGIES,
  type CaseResult,
  type EvalRun,
  type EvalStrategy,
  type ProfileRun,
} from "./run.js";

export const EvalStrategySchema = z.enum(EVAL_STRATEGIES);

/** One check type of a looped profile, over its scored cases. */
export const LoopedCheckSummary = z.object({
  /** Cases where it ran at least one pass. */
  cases: z.int(),
  /** Passes over those cases. */
  passes: z.int(),
  /** Most passes on one case. */
  maxPasses: z.int(),
  /** Findings it kept (before the merge across check types). */
  findings: z.int(),
  /** Findings verification dropped. */
  dropped: z.int(),
});
export type LoopedCheckSummary = z.infer<typeof LoopedCheckSummary>;

/** A looped profile's passes and verification. */
export const LoopedSummary = z.object({
  /** Findings verification dropped (rejected or unanswered) over the scored cases. */
  droppedFindings: z.int(),
  /** Per check type, in `LOOPED_REVIEW_CHECK_TYPES` order. */
  checks: z.record(z.string(), LoopedCheckSummary),
});
export type LoopedSummary = z.infer<typeof LoopedSummary>;

export const TokenStats = z.object({
  mean: z.number(),
  p50: z.number(),
  max: z.number(),
});
export type TokenStats = z.infer<typeof TokenStats>;

/** One profile's metrics; also what `evals/baseline.json` stores per profile. */
export const ProfileSummary = z.object({
  profileId: z.string(),
  /** Baseline entries from before strategies were recorded are single-pass. */
  strategy: EvalStrategySchema.default("single"),
  model: z.string().nullable(),
  /** Scored cases (errors, rate limits and aborted cases are left out). */
  cases: z.int(),
  caseIds: z.array(z.string()),
  /** Cases left out of the metrics. */
  unscored: z.int(),
  truePositives: z.int(),
  falsePositives: z.int(),
  falseNegatives: z.int(),
  /** TP / (TP + FP); null without findings. */
  precision: z.number().nullable(),
  /** TP / (TP + FN); null without expected findings. */
  recall: z.number().nullable(),
  /** False positives on clean cases (which expect none). */
  cleanFalsePositives: z.int(),
  /** Clean cases with at least one false positive. */
  cleanCasesFlagged: z.int(),
  cleanCases: z.int(),
  inputTokens: TokenStats,
  outputTokens: TokenStats,
  totalTokens: z.int(),
  durationMs: z.object({ mean: z.number(), total: z.number() }),
  /** Looped runs only. */
  looped: LoopedSummary.nullable().default(null),
});
export type ProfileSummary = z.infer<typeof ProfileSummary>;

const BaselineProfiles = z.record(z.string(), ProfileSummary);

const BaselineV2 = z.object({
  version: z.literal(2),
  updatedAt: z.string().nullable(),
  /** Per strategy, per profile: a run is only compared with its own strategy's entries. */
  strategies: z.object({
    single: BaselineProfiles.default({}),
    looped: BaselineProfiles.default({}),
  }),
});

/** A version 1 baseline (single-pass only, `profiles`) reads as version 2's `strategies.single`. */
function upgradeBaseline(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const v1 = value as { version?: unknown; updatedAt?: unknown; profiles?: unknown };
  if (v1.version !== 1) return value;
  return { version: 2, updatedAt: v1.updatedAt, strategies: { single: v1.profiles } };
}

/** `evals/baseline.json`. */
export const Baseline = z.preprocess(upgradeBaseline, BaselineV2);
export type Baseline = z.output<typeof BaselineV2>;

export const EMPTY_BASELINE: Baseline = {
  version: 2,
  updatedAt: null,
  strategies: { single: {}, looped: {} },
};

/** Metrics compared against the baseline (current − baseline). */
export const DELTA_METRICS = [
  "precision",
  "recall",
  "falsePositives",
  "falseNegatives",
  "cleanFalsePositives",
  "inputTokensMean",
  "inputTokensP50",
  "inputTokensMax",
  "outputTokensMean",
  "outputTokensP50",
  "outputTokensMax",
  "durationMsMean",
  "droppedFindings",
] as const;
export type DeltaMetric = (typeof DELTA_METRICS)[number];

export interface ProfileComparison {
  /** Null when the baseline has no entry for the profile. */
  baseline: ProfileSummary | null;
  deltas: Record<DeltaMetric, number | null>;
  /** The baseline was measured over a different set of cases. */
  caseSetChanged: boolean;
  /**
   * A looped run's single-pass baseline for the same profile, shown beside it
   * for reference (deltas are only against the same strategy's baseline).
   */
  singlePassBaseline: ProfileSummary | null;
}

export interface ProfileReport {
  summary: ProfileSummary;
  comparison: ProfileComparison;
  cases: CaseResult[];
}

export interface EvalReport {
  strategy: EvalStrategy;
  startedAt: string;
  finishedAt: string;
  /** The `--profile` argument. */
  selection: string;
  maxTotalTokens: number | null;
  totalTokens: number;
  aborted: { reason: string } | null;
  profiles: ProfileReport[];
}

const SCORED = new Set<CaseResult["stopReason"]>(["completed", "budget_exhausted"]);

/** Whether a case result counts toward the metrics. */
export const isScored = (result: CaseResult): boolean => SCORED.has(result.stopReason);

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function tokenStats(values: readonly number[]): TokenStats {
  if (values.length === 0) return { mean: 0, p50: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    p50: median(sorted),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

function summarizeLooped(scored: readonly CaseResult[]): LoopedSummary {
  const checks: Record<string, LoopedCheckSummary> = {};
  let droppedFindings = 0;
  for (const result of scored) {
    droppedFindings += result.looped?.dropped ?? 0;
    for (const check of result.looped?.checks ?? []) {
      const summary = (checks[check.checkType] ??= {
        cases: 0,
        passes: 0,
        maxPasses: 0,
        findings: 0,
        dropped: 0,
      });
      if (check.passes.length > 0) summary.cases++;
      summary.passes += check.passes.length;
      summary.maxPasses = Math.max(summary.maxPasses, check.passes.length);
      summary.findings += check.findings;
      summary.dropped += check.dropped;
    }
  }
  return { droppedFindings, checks };
}

export function summarizeProfile(
  run: ProfileRun,
  strategy: EvalStrategy = "single",
): ProfileSummary {
  const scored = run.cases.filter(isScored);
  const sum = (pick: (c: CaseResult) => number) => scored.reduce((a, c) => a + pick(c), 0);
  const tp = sum((c) => c.truePositives);
  const fp = sum((c) => c.falsePositives);
  const fn = sum((c) => c.falseNegatives);
  const clean = scored.filter((c) => c.clean);
  const durationTotal = sum((c) => c.durationMs);
  return {
    profileId: run.profile.id,
    strategy,
    model: run.profile.model,
    cases: scored.length,
    caseIds: scored.map((c) => c.id),
    unscored: run.cases.length - scored.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    cleanFalsePositives: clean.reduce((a, c) => a + c.falsePositives, 0),
    cleanCasesFlagged: clean.filter((c) => c.falsePositives > 0).length,
    cleanCases: clean.length,
    inputTokens: tokenStats(scored.map((c) => c.usage.inputTokens)),
    outputTokens: tokenStats(scored.map((c) => c.usage.outputTokens)),
    totalTokens: sum((c) => c.usage.inputTokens + c.usage.outputTokens),
    durationMs: {
      mean: scored.length === 0 ? 0 : Math.round(durationTotal / scored.length),
      total: durationTotal,
    },
    looped: strategy === "looped" ? summarizeLooped(scored) : null,
  };
}

function metric(summary: ProfileSummary, name: DeltaMetric): number | null {
  switch (name) {
    case "precision":
      return summary.precision;
    case "recall":
      return summary.recall;
    case "falsePositives":
      return summary.falsePositives;
    case "falseNegatives":
      return summary.falseNegatives;
    case "cleanFalsePositives":
      return summary.cleanFalsePositives;
    case "inputTokensMean":
      return summary.inputTokens.mean;
    case "inputTokensP50":
      return summary.inputTokens.p50;
    case "inputTokensMax":
      return summary.inputTokens.max;
    case "outputTokensMean":
      return summary.outputTokens.mean;
    case "outputTokensP50":
      return summary.outputTokens.p50;
    case "outputTokensMax":
      return summary.outputTokens.max;
    case "durationMsMean":
      return summary.durationMs.mean;
    case "droppedFindings":
      return summary.looped?.droppedFindings ?? null;
  }
}

export function compareToBaseline(
  summary: ProfileSummary,
  baseline: ProfileSummary | undefined,
  singlePassBaseline: ProfileSummary | null = null,
): ProfileComparison {
  const deltas = Object.fromEntries(
    DELTA_METRICS.map((name) => {
      const current = metric(summary, name);
      const before = baseline ? metric(baseline, name) : null;
      return [name, current === null || before === null ? null : current - before];
    }),
  ) as Record<DeltaMetric, number | null>;
  const caseSetChanged =
    baseline !== undefined &&
    [...baseline.caseIds].sort().join("\n") !== [...summary.caseIds].sort().join("\n");
  return { baseline: baseline ?? null, deltas, caseSetChanged, singlePassBaseline };
}

/**
 * The run's metrics per profile, each compared with the baseline entry of the
 * same strategy and profile; a looped run also carries the single-pass
 * baseline beside it.
 */
export function buildReport(run: EvalRun, baseline: Baseline, selection: string): EvalReport {
  const sameStrategy = baseline.strategies[run.strategy];
  return {
    strategy: run.strategy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    selection,
    maxTotalTokens: run.maxTotalTokens,
    totalTokens: run.totalTokens,
    aborted: run.aborted,
    profiles: run.profiles.map((profileRun) => {
      const summary = summarizeProfile(profileRun, run.strategy);
      return {
        summary,
        comparison: compareToBaseline(
          summary,
          sameStrategy[summary.profileId],
          run.strategy === "looped"
            ? (baseline.strategies.single[summary.profileId] ?? null)
            : null,
        ),
        cases: profileRun.cases,
      };
    }),
  };
}

/**
 * The baseline after `--update-baseline`: the profiles in the report replace
 * their entries of the report's strategy; other profiles and the other
 * strategy keep theirs.
 */
export function updatedBaseline(baseline: Baseline, report: EvalReport): Baseline {
  const profiles = { ...baseline.strategies[report.strategy] };
  for (const profile of report.profiles) profiles[profile.summary.profileId] = profile.summary;
  return {
    version: 2,
    updatedAt: report.finishedAt,
    strategies: { ...baseline.strategies, [report.strategy]: profiles },
  };
}

const pct = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null) =>
  value === null ? "–" : Math.round(value).toLocaleString("en-US");

function signed(value: number | null, format: (v: number) => string): string {
  if (value === null) return "–";
  if (value === 0) return "±0";
  return `${value > 0 ? "+" : "−"}${format(Math.abs(value))}`;
}

const RATE_METRICS = new Set<DeltaMetric>(["precision", "recall"]);

const METRIC_LABELS: Record<DeltaMetric, string> = {
  precision: "Precision",
  recall: "Recall",
  falsePositives: "False positives",
  falseNegatives: "False negatives",
  cleanFalsePositives: "False positives on clean cases",
  inputTokensMean: "Input tokens / case (mean)",
  inputTokensP50: "Input tokens / case (p50)",
  inputTokensMax: "Input tokens / case (max)",
  outputTokensMean: "Output tokens / case (mean)",
  outputTokensP50: "Output tokens / case (p50)",
  outputTokensMax: "Output tokens / case (max)",
  durationMsMean: "Duration / case (mean, ms)",
  droppedFindings: "Findings dropped by verification",
};

const STRATEGY_LABELS: Record<EvalStrategy, string> = { single: "single-pass", looped: "looped" };

/** Metrics only a looped run has. */
const LOOPED_METRICS = new Set<DeltaMetric>(["droppedFindings"]);

/** Markdown cell text: no pipes or newlines. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function renderProfile(profile: ProfileReport): string {
  const { summary, comparison } = profile;
  const lines: string[] = [];
  const looped = summary.strategy === "looped";
  lines.push(`## ${summary.profileId} (${summary.model ?? "default model"})`);
  lines.push("");
  lines.push(
    `${summary.cases} scored cases (${summary.cleanCases} clean), ${summary.unscored} unscored · ` +
      `TP ${summary.truePositives} · FP ${summary.falsePositives} · FN ${summary.falseNegatives} · ` +
      `clean cases flagged ${summary.cleanCasesFlagged}/${summary.cleanCases} · ` +
      `${num(summary.totalTokens)} tokens · ${num(summary.durationMs.total)} ms`,
  );
  lines.push("");
  if (!comparison.baseline) {
    lines.push(
      `_No ${STRATEGY_LABELS[summary.strategy]} baseline for this profile; run with \`--update-baseline\` to record one._`,
    );
    lines.push("");
  } else if (comparison.caseSetChanged) {
    lines.push("_The baseline was measured over a different set of cases; deltas are indicative._");
    lines.push("");
  }
  lines.push("| Metric | Current | Baseline | Δ |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const name of DELTA_METRICS) {
    if (LOOPED_METRICS.has(name) && !looped) continue;
    const isRate = RATE_METRICS.has(name);
    const format = isRate ? pct : num;
    const current = metric(summary, name);
    const before = comparison.baseline ? metric(comparison.baseline, name) : null;
    const delta = comparison.deltas[name];
    lines.push(
      `| ${METRIC_LABELS[name]} | ${format(current)} | ${format(before)} | ${signed(delta, (v) =>
        isRate ? `${(v * 100).toFixed(1)} pp` : num(v),
      )} |`,
    );
  }
  if (looped) lines.push("", ...renderLooped(summary, comparison));
  lines.push("");
  lines.push(
    `| Case | Kind | Stop | TP | FP | FN | Tokens in | Tokens out | ms |${looped ? " Passes | Dropped |" : ""}`,
  );
  lines.push(
    `| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |${looped ? " --- | ---: |" : ""}`,
  );
  for (const c of profile.cases) {
    const passes = looped ? ` ${passesCell(c)} | ${c.looped ? c.looped.dropped : "–"} |` : "";
    lines.push(
      `| ${c.id} | ${c.clean ? "clean" : "bad"} | ${c.stopReason} | ${c.truePositives} | ${c.falsePositives} | ${c.falseNegatives} | ${num(c.usage.inputTokens)} | ${num(c.usage.outputTokens)} | ${num(c.durationMs)} |${passes}`,
    );
  }
  const problems = profile.cases.filter(
    (c) => (isScored(c) && (c.falsePositives > 0 || c.falseNegatives > 0)) || c.error,
  );
  if (problems.length > 0) {
    lines.push("");
    lines.push("### Misses and false positives");
    for (const c of problems) {
      lines.push("");
      lines.push(`**${c.id}**`);
      if (c.error) lines.push(`- error: ${cell(c.error)}`);
      for (const f of c.findings.filter((f) => f.verdict !== "true_positive")) {
        const note = f.mustNotFlagNote ? ` (must not flag: ${cell(f.mustNotFlagNote)})` : "";
        lines.push(
          `- FP (${f.verdict}): \`${f.path}:${f.startLine}-${f.endLine}\` ${f.severity}/${f.category}: ${cell(f.title)}${note}`,
        );
      }
      for (const m of c.missed) {
        lines.push(
          `- FN: \`${m.path}:${m.startLine}-${m.endLine}\` ${m.category} (≥ ${m.minSeverity})`,
        );
      }
    }
  }
  return lines.join("\n");
}

/** A looped case's passes per check type that ran, e.g. `security 2, stability 1`. */
function passesCell(result: CaseResult): string {
  const ran = (result.looped?.checks ?? []).filter((check) => check.passes.length > 0);
  return ran.length === 0
    ? "–"
    : ran.map((check) => `${check.checkType} ${check.passes.length}`).join(", ");
}

/** A looped profile's passes per check type, and the single-pass baseline beside it. */
function renderLooped(summary: ProfileSummary, comparison: ProfileComparison): string[] {
  const lines: string[] = [];
  const single = comparison.singlePassBaseline;
  lines.push(
    single
      ? `Single-pass baseline: precision ${pct(single.precision)} · recall ${pct(single.recall)} · ` +
          `FP ${single.falsePositives} · FN ${single.falseNegatives} · ` +
          `clean cases flagged ${single.cleanCasesFlagged}/${single.cleanCases} · ` +
          `input tokens / case ${num(single.inputTokens.mean)} (mean)`
      : "_No single-pass baseline to show beside it._",
  );
  lines.push("");
  lines.push(
    "| Check type | Cases | Passes | Passes / case | Most | Findings kept | Dropped by verification |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [checkType, check] of Object.entries(summary.looped?.checks ?? {})) {
    const perCase = check.cases === 0 ? "–" : (check.passes / check.cases).toFixed(1);
    lines.push(
      `| ${checkType} | ${check.cases} | ${check.passes} | ${perCase} | ${check.maxPasses} | ${check.findings} | ${check.dropped} |`,
    );
  }
  return lines;
}

export function renderMarkdown(report: EvalReport): string {
  const header = [
    `# Review eval: ${report.selection} (${report.strategy})`,
    "",
    `Started ${report.startedAt}, finished ${report.finishedAt} · ${num(report.totalTokens)} tokens` +
      (report.maxTotalTokens !== null ? ` (cap ${num(report.maxTotalTokens)})` : ""),
  ];
  if (report.aborted) header.push("", `> **Aborted:** ${report.aborted.reason}`);
  return [header.join("\n"), ...report.profiles.map(renderProfile)].join("\n\n") + "\n";
}
