/**
 * `pnpm eval [--profile quick|standard|deep|all] [--case <id>]… [--max-total-tokens <n>] [--update-baseline]`
 *
 * Runs the real review (`runReview` + `ClaudeAgentProvider`, the host's Claude
 * login) over `evals/cases` and writes `evals/reports/<timestamp>-<profile>.{json,md}`.
 * Spends real tokens: never part of `pnpm test` or CI.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeAgentProvider } from "../providers/claude-agent.js";
import type { ReviewLogger } from "../providers/types.js";
import { loadCases } from "./case.js";
import { selectProfiles } from "./profiles.js";
import {
  Baseline,
  buildReport,
  EMPTY_BASELINE,
  renderMarkdown,
  updatedBaseline,
} from "./report.js";
import { runEval } from "./run.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const USAGE = `Usage: pnpm eval [options]

  --profile <quick|standard|deep|all>  Profiles to run (default: all)
  --case <id>                          Only this case; repeat for more
  --max-total-tokens <n>               Stop before the run spends more than n tokens
  --update-baseline                    Overwrite evals/baseline.json with this run's metrics
  --evals-dir <dir>                    Default: <repo>/evals
  -h, --help`;

class UsageError extends Error {}

export interface EvalArgs {
  profile: string;
  cases: string[];
  maxTotalTokens: number | undefined;
  updateBaseline: boolean;
  evalsDir: string;
  help: boolean;
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        profile: { type: "string", default: "all" },
        case: { type: "string", multiple: true, default: [] },
        "max-total-tokens": { type: "string" },
        "update-baseline": { type: "boolean", default: false },
        "evals-dir": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  let maxTotalTokens: number | undefined;
  const rawMax = values["max-total-tokens"];
  if (rawMax !== undefined) {
    maxTotalTokens = Number(rawMax.replace(/_/g, ""));
    if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens <= 0) {
      throw new UsageError(`--max-total-tokens must be a positive integer, got "${rawMax}"`);
    }
  }
  const cases = values.case
    .flatMap((c) => c.split(","))
    .map((c) => c.trim())
    .filter(Boolean);
  if (values["update-baseline"] && cases.length > 0) {
    throw new UsageError("--update-baseline needs the full case set; drop --case");
  }
  return {
    profile: values.profile,
    cases,
    maxTotalTokens,
    updateBaseline: values["update-baseline"],
    evalsDir: resolve(values["evals-dir"] ?? join(REPO_ROOT, "evals")),
    help: values.help,
  };
}

/** `2026-10-05T12-30-00Z`: sortable and safe in file names. */
export const reportTimestamp = (iso: string) => iso.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

async function readBaseline(path: string): Promise<Baseline> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return EMPTY_BASELINE;
  }
  return Baseline.parse(JSON.parse(text));
}

const stderrLogger: ReviewLogger = {
  info: () => {},
  warn: (data, message) => console.error(`warn: ${message}`, JSON.stringify(data)),
};

async function main(argv: readonly string[]): Promise<number> {
  const args = parseEvalArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const profiles = selectProfiles(args.profile);
  const cases = await loadCases(join(args.evalsDir, "cases"), args.cases);
  const baselinePath = join(args.evalsDir, "baseline.json");
  const baseline = await readBaseline(baselinePath);

  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.error("Interrupted; finishing the report…");
    controller.abort();
  });

  console.error(
    `Running ${cases.length} case(s) × ${profiles.map((p) => p.id).join(", ")}` +
      (args.maxTotalTokens !== undefined ? ` (max ${args.maxTotalTokens} tokens)` : ""),
  );
  const run = await runEval({
    cases,
    profiles,
    provider: new ClaudeAgentProvider({ logger: stderrLogger }),
    maxTotalTokens: args.maxTotalTokens,
    logger: stderrLogger,
    signal: controller.signal,
    onCase: (profileId, c) =>
      console.error(
        `${profileId}/${c.id}: ${c.stopReason} TP ${c.truePositives} FP ${c.falsePositives} FN ${c.falseNegatives} ` +
          `(${c.usage.inputTokens}+${c.usage.outputTokens} tokens, ${c.durationMs} ms)`,
      ),
  });

  const report = buildReport(run, baseline, args.profile);
  const reportsDir = join(args.evalsDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const stem = join(reportsDir, `${reportTimestamp(run.startedAt)}-${args.profile}`);
  await writeFile(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderMarkdown(report);
  await writeFile(`${stem}.md`, markdown);
  console.log(markdown);
  console.error(`Wrote ${relative(process.cwd(), stem)}.{json,md}`);

  if (run.aborted) {
    console.error(`Aborted: ${run.aborted.reason}`);
    if (args.updateBaseline) console.error("Baseline not updated (the run is incomplete).");
    return 2;
  }
  if (args.updateBaseline) {
    await writeFile(
      baselinePath,
      `${JSON.stringify(updatedBaseline(baseline, report), null, 2)}\n`,
    );
    console.error(`Updated ${relative(process.cwd(), baselinePath)}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof UsageError) console.error(`${error.message}\n\n${USAGE}`);
      else console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
