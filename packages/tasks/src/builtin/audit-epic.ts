/**
 * The epic audit: once every task of an epic is done, the story run invokes this
 * query task (trigger `run.invoked`, the story playbook's `auditTaskId`) in a
 * disposable checkout of the epic's lane branch, before the PR opens. A session
 * that saw none of the tasks being built checks each epic requirement against
 * the code and reports it `met` (with the file or test that shows it) or a `gap`
 * (with what is missing); the `run-result` sink hands the findings back to the
 * story run, which files each gap as a new task in the epic and audits again
 * once those are done (up to the story playbook's `maxAuditRounds`). The output
 * schema is fixed.
 */
import type { PlaybookInput, PlaybookPersona } from "../playbooks.js";

/** Checks a finished epic against its requirements, without changing it. */
export const EPIC_AUDITOR_PERSONA = {
  systemPrompt: `You are "Omniralph", auditing an epic whose tasks other sessions have built and committed. You haven't seen how they were built, and you judge only the code as it is now.
- Only read: inspect the repository and its git history (\`git log\`, \`git diff\`, \`git show\`). Don't edit files, commit, push, install dependencies or run gh/glab.
- Report your findings in your structured result (\`requirements\`, \`summary\`).`,
  tools: {
    builtin: ["Read", "Grep", "Glob", "Bash"],
    agent: [],
    tracker: [],
    mcpServers: [],
  },
} satisfies PlaybookPersona;

const AUDIT_EPIC_TEMPLATE = `Every task of "{{epic.title}}" ({{epic.identifier}}) is done, and each one was checked against its own acceptance criteria. Before it goes up for review, check the epic as a whole against each of its requirements (audit round {{audit.round}} of {{audit.maxRounds}}).

## Requirements
{{#requirements}}
{{#items}}
### {{id}}
{{text}}

{{/items}}
{{/requirements}}
{{#tasks}}
## Tasks done
What each task was built and checked against, so you know where to look:

{{#items}}
### {{identifier}}: {{title}}{{#repository}} (in \`{{repository}}\`, not this checkout){{/repository}}
{{#acceptanceCriteria}}
Acceptance criteria:
{{#items}}
{{.}}
{{/items}}
{{/acceptanceCriteria}}

{{/items}}
{{/tasks}}
{{#epic.prd}}
The epic, for context:
<epic>
{{epic.prd}}
</epic>

{{/epic.prd}}
## Audit the code
{{#commit}}
1. The working directory is a checkout of \`{{commit}}\`, the head of the epic's work on \`{{branch}}\`. Look at what it changed against \`{{baseBranch}}\` (\`git log --oneline origin/{{baseBranch}}..HEAD\`, \`git diff --stat origin/{{baseBranch}}...HEAD\`) and read the code itself.
{{/commit}}
{{^commit}}
1. The working directory is a checkout of \`{{branch}}\`, the epic's branch. Look at what it changed against \`{{baseBranch}}\` (\`git log --oneline origin/{{baseBranch}}..HEAD\`, \`git diff --stat origin/{{baseBranch}}...HEAD\`) and read the code itself.
{{/commit}}
2. For each requirement, decide whether the code meets it:
   - \`met\`: the code does what it says. In \`evidence\`, name the file (and function) or the test that shows it, in one or two sentences. Leave \`missing\` and \`title\` empty.
   - \`gap\`: it isn't met, or only partly. In \`missing\`, say concretely what is missing or wrong, so a new task can close it without guessing; in \`title\`, give that task a short imperative title. In \`evidence\`, say where you looked.
   - A requirement covered only by a task done in another repo counts as met on that task: say so in \`evidence\`.
   - Judge what the requirement asks for, not how you would have built it. Style, refactors and work the epic doesn't ask for are never a gap.
3. Don't change any files.
{{#audit.last}}

This is the last audit round: gaps you report now are listed in the {{prTerm}} description rather than built, so report only real ones.
{{/audit.last}}

Report one entry per requirement in \`requirements\` (\`id\` as written above, \`status\`, \`evidence\`, \`missing\` and \`title\`), and a short \`summary\` of the audit.`;

export const AUDIT_EPIC_PLAYBOOK: PlaybookInput = {
  id: "builtin:audit-epic",
  name: "Audit an epic",
  description:
    "Checks an epic whose tasks are all done against each of its requirements before its PR opens; each gap becomes a new task in the epic.",
  role: "audit",
  ...EPIC_AUDITOR_PERSONA,
  promptTemplate: AUDIT_EPIC_TEMPLATE,
  toolSettings: { shell: true, trackerRead: false, network: false },
  outputSchema: {
    type: "object",
    properties: {
      requirements: {
        type: "array",
        description: "One finding per requirement, in the order given.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The requirement's identifier, as written." },
            status: {
              type: "string",
              enum: ["met", "gap"],
              description: "Whether the code meets it.",
            },
            evidence: {
              type: "string",
              description: "The file or test that shows it's met, or where you looked.",
            },
            missing: {
              type: "string",
              description: "For a gap: what is missing or wrong. Empty when met.",
            },
            title: {
              type: "string",
              description: "For a gap: a short imperative title for the task that closes it.",
            },
          },
          required: ["id", "status", "evidence", "missing", "title"],
          additionalProperties: false,
        },
      },
      summary: { type: "string", description: "A short summary of the audit." },
    },
    required: ["requirements", "summary"],
    additionalProperties: false,
  },
  // Reading the whole epic's code against its requirements is the harder check: the stronger model.
  model: "claude-opus-5-5",
  tokenBudget: null,
};
