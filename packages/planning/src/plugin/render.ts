/**
 * The omniralph-prd Claude plugin, rendered as the files of its marketplace
 * repo. The shared planning rules come from `SHARED_RULES`, the same fragments
 * the triage prompts render; only the interactive, plugin-only text lives in
 * `src/plugin/`.
 */
import {
  type Fragment,
  type MethodologyContext,
  SHARED_RULES,
  renderFragment,
  renderSection,
} from "../methodology/rules.js";
import {
  CLARIFYING_QUESTIONS,
  COMMON_INTRO,
  DRAFTING_TASKS,
  TRACKER_STRUCTURE,
  WORKED_EXAMPLE,
} from "./common.js";
import { PLUGIN_MODES } from "./modes.js";
import { SKILL_BODY, SKILL_DESCRIPTION, SKILL_NAME } from "./skill.js";

/** One file of the plugin's marketplace repo. */
export interface PluginFile {
  /** The path from the marketplace repo's root, with `/` separators. */
  path: string;
  content: string;
}

/** The tracker the plugin plans in: it drives Linear through the Linear MCP. */
export const PLUGIN_CONTEXT: MethodologyContext = {
  trackerName: "Linear",
  conventionsFile: "LINEAR.md",
};

/** The plugin's name, in the marketplace and as its directory. */
export const PLUGIN_NAME = SKILL_NAME;

/** The plugin's directory in the marketplace repo; the build replaces it whole. */
export const PLUGIN_DIR = `plugins/${PLUGIN_NAME}`;

/** What every generated file says first. */
export const GENERATED_NOTICE =
  "Generated from the omniralph repo (packages/planning/src/plugin, built by scripts/build-prd-plugin.ts). Do not edit by hand: change it in the omniralph repo, and CI publishes it here.";

const PLUGIN_DESCRIPTION =
  "Plan epics, stories and fixes in Linear for Omniralph to build, with t-shirt sizing and epic decomposition.";

const AUTHOR = { name: "Steve McMaster" };

const SKILL_DIR = `${PLUGIN_DIR}/skills/${SKILL_NAME}`;

function json(value: unknown): string {
  return `${JSON.stringify({ $comment: GENERATED_NOTICE, ...(value as object) }, null, 2)}\n`;
}

function markdown(body: string): string {
  return `<!-- ${GENERATED_NOTICE} -->\n\n${body.trimEnd()}\n`;
}

function section(fragment: Fragment, level: number): string {
  return renderSection(fragment, level, PLUGIN_CONTEXT);
}

/** `SKILL.md`: its frontmatter (the notice first, as a YAML comment), then the body. */
export function renderSkill(): string {
  return `---
# ${GENERATED_NOTICE}
name: ${SKILL_NAME}
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---

${SKILL_BODY.trimEnd()}
`;
}

/**
 * `references/common.md`: how Omniralph builds the plan, the clarifying
 * questions, every shared planning rule, drafting tasks, writing to the
 * tracker and a worked example.
 */
export function renderCommon(): string {
  return markdown(
    [
      "# Shared planning methodology",
      renderFragment(COMMON_INTRO, PLUGIN_CONTEXT),
      "---",
      section(CLARIFYING_QUESTIONS, 2),
      "---",
      "## Planning rules",
      "These rules are the same ones Omniralph's own triage follows.",
      ...SHARED_RULES.map((rule) => section(rule, 3)),
      "---",
      section(DRAFTING_TASKS, 2),
      "---",
      section(
        { ...TRACKER_STRUCTURE, title: renderFragment(TRACKER_STRUCTURE.title, PLUGIN_CONTEXT) },
        2,
      ),
      "---",
      section(WORKED_EXAMPLE, 2),
    ].join("\n\n"),
  );
}

/**
 * Every file of the marketplace repo the plugin owns, in a fixed order: the
 * marketplace manifest, the plugin manifest, `SKILL.md` and its references.
 */
export function renderPluginFiles(): PluginFile[] {
  return [
    {
      path: ".claude-plugin/marketplace.json",
      content: json({
        name: PLUGIN_NAME,
        owner: AUTHOR,
        metadata: { description: PLUGIN_DESCRIPTION },
        plugins: [
          {
            name: PLUGIN_NAME,
            source: `./${PLUGIN_DIR}`,
            description: PLUGIN_DESCRIPTION,
          },
        ],
      }),
    },
    {
      path: `${PLUGIN_DIR}/.claude-plugin/plugin.json`,
      content: json({ name: PLUGIN_NAME, description: PLUGIN_DESCRIPTION, author: AUTHOR }),
    },
    { path: `${SKILL_DIR}/SKILL.md`, content: renderSkill() },
    { path: `${SKILL_DIR}/references/common.md`, content: renderCommon() },
    ...PLUGIN_MODES.map((mode) => ({
      path: `${SKILL_DIR}/references/${mode.file}`,
      content: markdown(renderFragment(mode.body, PLUGIN_CONTEXT)),
    })),
  ];
}
