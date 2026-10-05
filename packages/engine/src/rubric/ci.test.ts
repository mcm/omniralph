import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../diff.js";
import { planReview } from "../plan.js";
import { buildPrompt, type ReviewProfileConfig } from "../prompt.js";
import { isCiWorkflowPath, languageRubric, languagesForPaths } from "./index.js";

// The two problems the TOOL-49 smoke test (mcm/schematiclab#24) missed in
// `.github/workflows/ci.yml`, whose other actions are all pinned to SHAs.
const fixture = (name: string) =>
  parseDiff(readFileSync(new URL(`../../test/fixtures/${name}.diff`, import.meta.url), "utf8"));

const standard: ReviewProfileConfig = {
  id: "standard",
  name: "Standard",
  maxTokensPerReview: 200_000,
  maxFiles: 40,
  allowRepoExploration: true,
};

function promptFor(name: string) {
  const plan = planReview(fixture(name), standard);
  return buildPrompt({
    config: { profile: standard },
    files: plan.tasks[0]!.files,
    changeRequest: { title: "Update CI" },
  });
}

describe("CI workflow rubric", () => {
  it("matches GitHub Actions workflows and GitLab CI by path", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
      ".gitlab-ci.yml",
      "services/api/.gitlab-ci.yml",
    ]) {
      expect(isCiWorkflowPath(path), path).toBe(true);
    }
    for (const path of [
      ".github/dependabot.yml",
      ".github/workflows/scripts/check.sh",
      "docs/.github/workflows/ci.yml",
      "config/ci.yml",
      "gitlab-ci.yml",
    ]) {
      expect(isCiWorkflowPath(path), path).toBe(false);
    }
    expect(languagesForPaths(["src/a.ts", ".github/workflows/ci.yml", "x.py"])).toEqual([
      "typescript",
      "python",
      "ci",
    ]);
    expect(languagesForPaths([".gitlab-ci.yml"])).toEqual(["ci"]);
  });

  it("puts the pinning-convention rule in the prompt for a tag-pinned action", () => {
    const prompt = promptFor("workflow-pinning");
    expect(prompt.text).toContain("+      - uses: actions/upload-artifact@v4");
    expect(prompt.languages).toEqual(["ci"]);
    expect(prompt.stablePrefix).toContain(languageRubric("ci"));
    expect(prompt.stablePrefix).toContain("breaks the file's own pinning convention");
    expect(prompt.stablePrefix).toMatch(
      /pin to a full commit SHA, a new or changed reference pinned to a tag/,
    );
  });

  it("puts the missing-producer rule in the prompt for a step reading an ungenerated file", () => {
    const prompt = promptFor("workflow-missing-artifact");
    expect(prompt.text).toContain("coverage/coverage-summary.json)");
    expect(prompt.languages).toEqual(["ci"]);
    expect(prompt.stablePrefix).toContain(languageRubric("ci"));
    expect(prompt.stablePrefix).toMatch(
      /Flag a step that reads a file, directory or artifact .* that no earlier step/,
    );
  });

  it("covers untrusted `${{ }}` expressions in `run:`", () => {
    const prompt = promptFor("workflow-injection");
    expect(prompt.stablePrefix).toContain(
      "Flag `${{ }}` expressions that expand untrusted event fields inside `run:`",
    );
    expect(prompt.stablePrefix).toContain("github.event.pull_request.title");
  });

  it("is left out when no CI file changed", () => {
    const prompt = promptFor("basic");
    expect(prompt.languages).not.toContain("ci");
    expect(prompt.stablePrefix).not.toContain("# CI workflows");
  });
});
