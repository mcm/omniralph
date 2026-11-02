/**
 * The built-in playbooks (IDs `builtin:<name>`), shipped in code. Port
 * stories add theirs to `PLAYBOOK_INPUTS`; `builtinProblems` (run by a test
 * over the registry) checks they're valid.
 */
import { ASK_ABOUT_CODE_PLAYBOOK } from "./builtin/ask-about-code.js";
import { CORRELATE_FINDINGS_PLAYBOOK } from "./builtin/correlate-findings.js";
import { DESCRIBE_PR_PLAYBOOK } from "./builtin/describe-pr.js";
import { HANDLE_REQUEST_PLAYBOOK } from "./builtin/handle-request.js";
import { IMPLEMENT_STORY_PLAYBOOK } from "./builtin/implement-story.js";
import { LEARN_RULE_PLAYBOOK } from "./builtin/learn-rule.js";
import { REPLY_PLAYBOOK } from "./builtin/reply.js";
import { REVIEW_PR_PLAYBOOK } from "./builtin/review-pr.js";
import { SUMMARIZE_PR_PLAYBOOK } from "./builtin/summarize-pr.js";
import { TRIAGE_PLAYBOOK } from "./builtin/triage.js";
import { VERIFY_TASK_PLAYBOOK } from "./builtin/verify-task.js";
import { validateCodingTask } from "./coding.js";
import type { TaskDefinition } from "./definitions.js";
import { isBuiltinId } from "./ids.js";
import {
  Playbook,
  playbookRunSpec,
  type PlaybookInput,
  type PlaybookRunSpec,
} from "./playbooks.js";
import { validateTemplate } from "./template.js";
import { taskVariables } from "./variables.js";

const PLAYBOOK_INPUTS: readonly PlaybookInput[] = [
  LEARN_RULE_PLAYBOOK,
  REPLY_PLAYBOOK,
  REVIEW_PR_PLAYBOOK,
  SUMMARIZE_PR_PLAYBOOK,
  ASK_ABOUT_CODE_PLAYBOOK,
  TRIAGE_PLAYBOOK,
  CORRELATE_FINDINGS_PLAYBOOK,
  IMPLEMENT_STORY_PLAYBOOK,
  HANDLE_REQUEST_PLAYBOOK,
  DESCRIBE_PR_PLAYBOOK,
  VERIFY_TASK_PLAYBOOK,
];

export const BUILTIN_PLAYBOOKS: readonly Playbook[] = PLAYBOOK_INPUTS.map((playbook) =>
  Playbook.parse(playbook),
);

/**
 * The run spec task of each built-in playbook (`playbookRunSpec`), for code
 * that reads a built-in's task type, triggers, sink or coding settings.
 */
export const BUILTIN_TASKS: readonly TaskDefinition[] = BUILTIN_PLAYBOOKS.map(
  (playbook) => playbookRunSpec(playbook).task,
);

/** The built-in playbook with `id`, or null. */
export function getBuiltinPlaybook(id: string): Playbook | null {
  return BUILTIN_PLAYBOOKS.find((playbook) => playbook.id === id) ?? null;
}

/** The run spec task of the built-in playbook with `id`, or null. */
export function getBuiltinTask(id: string): TaskDefinition | null {
  return BUILTIN_TASKS.find((task) => task.id === id) ?? null;
}

/**
 * Problems with a set of built-in playbooks; empty when they're fine. Each
 * must parse (`Playbook`), have a unique `builtin:` ID and a template (and
 * variable limits) using only the variables its role's task type and
 * triggers provide; a story or request playbook must pass `validateCodingTask`
 * (its PR description playbook one of `playbooks`).
 */
export function builtinProblems(playbooks: readonly unknown[]): string[] {
  const problems: string[] = [];
  const tasks = new Map<string, TaskDefinition>();

  playbooks.forEach((input, index) => {
    const parsed = Playbook.safeParse(input);
    if (!parsed.success) {
      problems.push(`Playbook #${index + 1} doesn't parse: ${parsed.error.message}`);
      return;
    }
    const playbook = parsed.data;
    if (!isBuiltinId(playbook.id)) {
      problems.push(`Playbook ${playbook.id} doesn't have a builtin: ID.`);
    }
    if (tasks.has(playbook.id)) problems.push(`Playbook ${playbook.id} is defined twice.`);
    const { task } = playbookRunSpec(playbook);
    tasks.set(playbook.id, task);
    const available = taskVariables(task);
    for (const problem of validateTemplate(task.promptTemplate, available)) {
      const what = problem.kind === "parse" ? problem.message : `unknown variable ${problem.name}`;
      problems.push(
        `Playbook ${playbook.id} template (${problem.line}:${problem.column}): ${what}`,
      );
    }
    for (const name of Object.keys(task.variableLimits ?? {})) {
      if (!available.includes(name))
        problems.push(`Playbook ${playbook.id} limits the unknown variable ${name}.`);
    }
  });
  for (const task of tasks.values()) {
    const errors = validateCodingTask(task, (id) => tasks.get(id) ?? null);
    for (const [field, message] of Object.entries(errors)) {
      problems.push(`Playbook ${task.id} ${field}: ${message}`);
    }
  }
  return problems;
}

/** The run spec `agent` and `task` of the built-in playbook with `id` (`playbookRunSpec`), or null. */
export function getBuiltinRunSpec(id: string): PlaybookRunSpec | null {
  const playbook = getBuiltinPlaybook(id);
  return playbook && playbookRunSpec(playbook);
}
