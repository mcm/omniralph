import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SHARED_RULES, renderFragment } from "../methodology/rules.js";
import { EPIC_TEMPLATE, FIX_TEMPLATE, STORY_TEMPLATE } from "../methodology/templates.js";
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
import { PLUGIN_MODES } from "./modes.js";
import {
  GENERATED_NOTICE,
  PLUGIN_CONTEXT,
  renderCommon,
  renderPluginFiles,
  renderSkill,
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

  it("has no success metrics or quality gates instructions", () => {
    for (const file of files) {
      expect(file.content).not.toMatch(/success metrics?/i);
      expect(file.content).not.toMatch(/quality gates?/i);
    }
  });

  it("describes the formats, the dependency rules and the evidence rule", () => {
    const common = renderCommon();
    for (const template of [EPIC_TEMPLATE, STORY_TEMPLATE, FIX_TEMPLATE]) {
      expect(common).toContain(template);
    }
    expect(common).toContain("### Dependency rules");
    expect(common).toContain("Acceptance criteria are evidence to check, not tests to write.");
  });
});

describe("the plugin's methodology", () => {
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

  it("gives a worked example that parses as an epic, a story and a fix and lints clean", () => {
    const epic = parseWorkItem(EXAMPLE_EPIC);
    expect(epic?.format).toBe("epic");
    expect(lintWorkItem(EXAMPLE_EPIC)).toEqual([]);

    const epicRequirements = (epic?.requirements ?? []).map((requirement) => requirement.id);
    expect(epicRequirements).toEqual(["FR-1", "FR-2", "FR-3", "FR-4"]);
    expect(parseWorkItem(EXAMPLE_STORY)?.format).toBe("story");
    expect(lintWorkItem(EXAMPLE_STORY, { epicRequirements })).toEqual([]);
    expect(parseWorkItem(EXAMPLE_FIX)?.format).toBe("fix");
    expect(lintWorkItem(EXAMPLE_FIX, { epicRequirements })).toEqual([]);
  });

  it("matches the SKILL.md snapshot", async () => {
    await expect(renderSkill()).toMatchFileSnapshot("__snapshots__/SKILL.md");
  });

  it("matches the common.md snapshot", async () => {
    await expect(renderCommon()).toMatchFileSnapshot("__snapshots__/common.md");
  });
});
