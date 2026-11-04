import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DOCUMENT_RULES, PLAN_RULE, PRFAQ_RULE } from "../methodology/documents.js";
import { SHARED_RULES, renderFragment, renderSection } from "../methodology/rules.js";
import { EPIC_TEMPLATE, TASK_TEMPLATE } from "../methodology/templates.js";
import { renderTriageMethodology } from "../methodology/triage.js";
import { lintWorkItem } from "../work-item/lint.js";
import { parseWorkItem } from "../work-item/parse.js";
import { writePluginMarketplace } from "./build.js";
import {
  CLARIFYING_QUESTIONS,
  COMMON_INTRO,
  DRAFTING_TASKS,
  EXAMPLE_EPIC,
  EXAMPLE_FIX,
  EXAMPLE_STORY,
  TRACKER_STRUCTURE,
} from "./common.js";
import { MODE_PLAN, MODE_PRFAQ, PLUGIN_MODES, REVIEW_TASK_TEMPLATE } from "./modes.js";
import {
  GENERATED_NOTICE,
  PLUGIN_CONTEXT,
  renderCommon,
  renderMode,
  renderPluginFiles,
} from "./render.js";
import { SKILL_BODY } from "./skill.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "prd-plugin-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readTree(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const tree: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    tree[path.relative(root, full).split(path.sep).join("/")] = await readFile(full, "utf8");
  }
  return tree;
}

const SKILL_DIR = "plugins/omniralph-prd/skills/omniralph-prd";

const DOCUMENT_MODES = [MODE_PRFAQ, MODE_PLAN];

function modePath(mode: { file: string }): string {
  return `${SKILL_DIR}/references/${mode.file}`;
}

describe("writePluginMarketplace", () => {
  it("writes the full marketplace layout", async () => {
    const dir = await tempDir();
    await writePluginMarketplace(dir);
    expect(Object.keys(await readTree(dir)).sort()).toEqual(
      [
        ".claude-plugin/marketplace.json",
        "plugins/omniralph-prd/.claude-plugin/plugin.json",
        `${SKILL_DIR}/SKILL.md`,
        `${SKILL_DIR}/references/common.md`,
        `${SKILL_DIR}/references/mode-new.md`,
        `${SKILL_DIR}/references/mode-triage.md`,
        `${SKILL_DIR}/references/mode-edit.md`,
        `${SKILL_DIR}/references/mode-ui-loop.md`,
        `${SKILL_DIR}/references/mode-prfaq.md`,
        `${SKILL_DIR}/references/mode-plan.md`,
      ].sort(),
    );
  });

  it("builds the same files every time", async () => {
    const first = await tempDir();
    const second = await tempDir();
    await writePluginMarketplace(first);
    await writePluginMarketplace(second);
    expect(await readTree(second)).toEqual(await readTree(first));
  });

  it("replaces the plugin directory and leaves the rest of the repo alone", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, SKILL_DIR, "references"), { recursive: true });
    await writeFile(path.join(dir, SKILL_DIR, "references", "mode-old.md"), "stale");
    await writeFile(path.join(dir, "README.md"), "readme");

    await writePluginMarketplace(dir);

    const tree = await readTree(dir);
    expect(tree[`${SKILL_DIR}/references/mode-old.md`]).toBeUndefined();
    expect(tree["README.md"]).toBe("readme");
  });
});

describe("renderPluginFiles", () => {
  const files = renderPluginFiles();

  it("starts every file with the generated notice", () => {
    for (const file of files) {
      if (file.path.endsWith(".json")) {
        const [firstKey, value] = Object.entries(JSON.parse(file.content) as object)[0]!;
        expect([file.path, firstKey, value]).toEqual([file.path, "$comment", GENERATED_NOTICE]);
      } else if (file.path.endsWith("SKILL.md")) {
        // The frontmatter must open the file, so the notice is its first line, as a YAML comment.
        expect(file.content.split("\n").slice(0, 2)).toEqual(["---", `# ${GENERATED_NOTICE}`]);
      } else {
        expect(file.content.split("\n")[0]).toBe(`<!-- ${GENERATED_NOTICE} -->`);
      }
    }
  });

  it("fills in every placeholder", () => {
    for (const file of files) expect(file.content).not.toMatch(/\{\{\w+\}\}/);
  });

  it("has no quality gates instructions", () => {
    for (const file of files) expect(file.content).not.toMatch(/quality gates?/i);
  });

  it("asks for success metrics only in the PRFAQ and Plan modes", () => {
    const allowed = [`${SKILL_DIR}/SKILL.md`, ...DOCUMENT_MODES.map(modePath)];
    for (const file of files.filter((f) => !allowed.includes(f.path))) {
      expect([file.path, file.content]).not.toEqual([
        file.path,
        expect.stringMatching(/success metrics?/i),
      ]);
    }
    // SKILL.md names them only to keep them out of epics and tasks.
    const skill = files.find((f) => f.path === `${SKILL_DIR}/SKILL.md`)!.content;
    expect(skill.match(/success metrics[^.]*\./gi)).toEqual([
      "success metrics are for people: they stay in its PRFAQ or Plan\n  and never reach an epic or a task.",
    ]);
  });

  it("describes the formats, the dependency rules and the evidence rule", () => {
    const common = renderCommon();
    for (const template of [EPIC_TEMPLATE, TASK_TEMPLATE]) {
      expect(common).toContain(template);
    }
    expect(common).toContain("### Dependency rules");
    expect(common).toContain("each one evidence to check, not a test to write");
  });
});

describe("the plugin's methodology", () => {
  const files = renderPluginFiles();

  it("renders every shared rule exactly as the triage prompts do", () => {
    const common = renderCommon();
    const triage = renderTriageMethodology(PLUGIN_CONTEXT);
    for (const rule of SHARED_RULES) {
      const text = `### ${rule.title}\n\n${renderFragment(rule.body, PLUGIN_CONTEXT)}`;
      expect(common).toContain(text);
      expect(triage).toContain(text);
    }
  });

  it("doesn't copy a shared rule into its plugin-only text", () => {
    const pluginOnly = [
      SKILL_BODY,
      COMMON_INTRO,
      CLARIFYING_QUESTIONS.body,
      DRAFTING_TASKS.body,
      TRACKER_STRUCTURE.body,
      ...PLUGIN_MODES.map((mode) => mode.body),
    ];
    for (const rule of SHARED_RULES) {
      for (const line of rule.body.split("\n").filter((text) => text.length > 60)) {
        for (const text of pluginOnly) expect(text).not.toContain(line);
      }
    }
  });

  it("gives a worked example that parses as an epic and two tasks and lints clean", () => {
    const epic = parseWorkItem(EXAMPLE_EPIC);
    expect(epic?.format).toBe("epic");
    expect(lintWorkItem(EXAMPLE_EPIC)).toEqual([]);
    expect(epic?.requirements.map((requirement) => requirement.id)).toEqual([
      "FR-1",
      "FR-2",
      "FR-3",
      "FR-4",
    ]);
    for (const task of [EXAMPLE_STORY, EXAMPLE_FIX]) {
      expect(parseWorkItem(task)?.format).toBe("task");
      expect(lintWorkItem(task)).toEqual([]);
    }
  });

  it("gives a review task template for ui-loop that, filled in, parses as a task and lints clean", () => {
    const filled = REVIEW_TASK_TEMPLATE.replaceAll("FR-1: …", "FR-1 holds").replace(
      /<[^>]+>/g,
      "x",
    );
    const task = parseWorkItem(filled);
    expect(task?.format).toBe("task");
    expect(lintWorkItem(filled)).toEqual([]);
    // The verifier sees only paragraphs 1 and 3: the review's constraints are there.
    expect(task?.acceptanceCriteria).toContain(
      "No file outside `.impeccable/critique/` changes: this task reviews, it doesn't fix",
    );
    expect(task?.approach).toContain("Anchoring the critique");
  });

  it("writes tasks in the three-paragraph shape in every mode", () => {
    for (const file of files.filter((f) => f.path.endsWith(".md"))) {
      expect([file.path, file.content]).not.toEqual([
        file.path,
        expect.stringMatching(/\b(story|fix|story or fix) format\b/i),
      ]);
      // A task is never drafted with a Covers line or an acceptance-criteria checklist.
      expect([file.path, file.content]).not.toEqual([
        file.path,
        expect.stringMatching(/^(Covers: FR|Acceptance criteria:$|## Acceptance Criteria$)/m),
      ]);
    }
    for (const mode of PLUGIN_MODES.filter((m) => ["new", "triage", "edit"].includes(m.id))) {
      expect(mode.body).toContain("three paragraphs");
      expect(mode.body).toContain("bug label");
    }
  });

  // The snapshots are the committed plugin: CI fails when the generator's output drifts from them.
  it.each(files.map((f) => f.path))("commits %s as the generator writes it", async (filePath) => {
    const file = files.find((f) => f.path === filePath)!;
    await expect(file.content).toMatchFileSnapshot(
      `__snapshots__/${path.posix.basename(filePath)}`,
    );
  });

  it("lists every mode in SKILL.md with its invocation and reference file", () => {
    const skill = files.find((f) => f.path === `${SKILL_DIR}/SKILL.md`)!.content;
    for (const mode of PLUGIN_MODES) {
      expect(skill).toMatch(
        new RegExp(`^\\| \`${mode.id}\` \\| \`/omniralph-prd ${mode.id}[ \`]`, "m"),
      );
      expect(skill).toContain(`- \`${mode.id}\` → \`references/${mode.file}\``);
      expect(skill).toContain(`\`/omniralph-prd ${mode.id}`);
    }
    expect(skill).toContain("`/omniralph-prd prfaq [context]`");
    expect(skill).toContain("`/omniralph-prd plan [context]`");
  });
});

describe("the prfaq and plan modes", () => {
  it.each([
    { id: MODE_PRFAQ.id, mode: MODE_PRFAQ, rule: PRFAQ_RULE },
    { id: MODE_PLAN.id, mode: MODE_PLAN, rule: PLAN_RULE },
  ])("renders the $id mode's document rule after its steps", ({ mode, rule }) => {
    const rendered = renderMode(mode);
    const steps = renderFragment(mode.body, PLUGIN_CONTEXT);
    expect(rendered).toContain(steps);
    for (const fragment of [rule, DOCUMENT_RULES.find((r) => r.id === "success-metrics")!]) {
      const text = renderSection(fragment, 2, PLUGIN_CONTEXT);
      expect(rendered).toContain(text);
      expect(rendered.indexOf(text)).toBeGreaterThan(rendered.indexOf(steps));
    }
  });

  it.each(DOCUMENT_MODES.map((mode) => [mode.id, mode] as const))(
    "%s reads and saves its own document kind through the API, or hands it over to paste",
    (id, mode) => {
      const rendered = renderMode(mode);
      expect(rendered).toContain(`GET $OMNIRALPH_URL/api/ui/features/<id>/documents/${id}\``);
      expect(rendered).toContain(`PUT $OMNIRALPH_URL/api/ui/features/<id>/documents/${id}\``);
      expect(rendered).toContain("**The Omniralph API is not configured**");
      expect(rendered).toContain("ready to paste");
      // Neither mode files anything in the tracker.
      expect(rendered).toContain("Write nothing to Linear");
      expect(rendered).not.toMatch(/blockedBy|save_issue/);
    },
  );
});
