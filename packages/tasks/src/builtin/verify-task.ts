/**
 * Task verification: once a story attempt's session reports the story complete
 * and its checks pass, the story run invokes this query task (trigger
 * `run.invoked`, the story playbook's `verifierTaskId`) in a disposable
 * checkout of the attempt's commit. An independent session that never saw
 * the worker's reasoning reviews the change against each acceptance
 * criterion and accepts it or sends it back with a reason; the `run-result`
 * sink hands the verdicts back to the story run, which counts the story done
 * or fails the attempt with the reasons as its feedback. It is a light check
 * of evidence, not a test-writing step. The output schema is fixed.
 */
import type { PlaybookInput, PlaybookPersona } from "../playbooks.js";

/** Checks finished work against its acceptance criteria, without changing it. */
export const TASK_VERIFIER_PERSONA = {
  systemPrompt: `You are "Omniralph", verifying work another session has already committed. You haven't seen how it was done, and you judge only the change itself.
- Only read: inspect the repository and its git history (\`git show\`, \`git log\`, \`git diff\`). Don't edit files, commit, push, install dependencies or run gh/glab.
- Report your verdicts in your structured result (\`criteria\`, \`summary\`).`,
  tools: {
    builtin: ["Read", "Grep", "Glob", "Bash"],
    agent: [],
    tracker: [],
    mcpServers: [],
  },
} satisfies PlaybookPersona;

const VERIFY_TASK_TEMPLATE = `A session working through "{{epic.title}}" ({{epic.identifier}}) reported the task below complete, and its checks passed. Before the task counts as done, check the change against each of its acceptance criteria.

## Task: {{story.identifier}} - {{story.title}}
{{#story.description}}
### Description
{{story.description}}

{{/story.description}}
{{#story.acceptanceCriteria}}
### Acceptance Criteria
A criterion is evidence to check, not a test to demand: it holds when the code, a command's output or an existing test shows it. A test that only asserts a file exists or what a config contains doesn't show a criterion holds.
{{#items}}
- {{.}}
{{/items}}

{{/story.acceptanceCriteria}}
{{^story.acceptanceCriteria}}
The task lists no acceptance criteria: check the change against what its description asks for, as one criterion ("The change does what the task describes").

{{/story.acceptanceCriteria}}
{{#epic.prd}}
Background from the epic, for context only (don't check its other requirements; other tasks own them):
<epic-background>
{{epic.prd}}
</epic-background>

{{/epic.prd}}
{{#qualityGates}}
These checks already passed, so don't run them again:
{{#items}}
- \`{{.}}\`
{{/items}}

{{/qualityGates}}
## Check the change
{{#commit}}
1. The working directory is a checkout of the task's commit \`{{commit}}\` on \`{{branch}}\`. Read what it changed: \`git show --stat {{commit}}\`, then \`git show {{commit}}\`, opening files where the diff alone isn't clear.
{{/commit}}
{{^commit}}
1. The session committed nothing for this task, so the work must already be on \`{{branch}}\`, which is checked out. Look at what the branch changed against \`{{baseBranch}}\` (\`git log origin/{{baseBranch}}..HEAD\`, \`git diff origin/{{baseBranch}}...HEAD\`) and at the code itself.
{{/commit}}
2. For each acceptance criterion, decide whether the code meets it:
   - Accept it when the change (or code already there) does what it says. Give the evidence in one or two sentences, naming the files or tests.
   - Send it back when it isn't met, or is only partly met. Say concretely what is missing or wrong, so the next session can fix it without guessing.
   - Judge what the criterion asks for, not how you would have built it. Style preferences, refactors and work outside the task are never a reason to send a criterion back.
3. Don't change any files.

Report one entry per criterion in \`criteria\` (\`criterion\` as written above, \`accepted\`, and the \`reason\`), and a short \`summary\` of your verdict.`;

export const VERIFY_TASK_PLAYBOOK: PlaybookInput = {
  id: "builtin:verify-task",
  name: "Verify a task",
  description:
    "Checks a task its session reported complete against the task's acceptance criteria, before the task counts as done.",
  role: "verifier",
  ...TASK_VERIFIER_PERSONA,
  promptTemplate: VERIFY_TASK_TEMPLATE,
  toolSettings: { shell: true, trackerRead: false, network: false },
  outputSchema: {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        description: "One verdict per acceptance criterion, in the order given.",
        items: {
          type: "object",
          properties: {
            criterion: { type: "string", description: "The criterion, as written." },
            accepted: { type: "boolean", description: "Whether the change meets it." },
            reason: {
              type: "string",
              description: "The evidence it's met, or what is missing or wrong.",
            },
          },
          required: ["criterion", "accepted", "reason"],
          additionalProperties: false,
        },
      },
      summary: { type: "string", description: "A short summary of the verdict." },
    },
    required: ["criteria", "summary"],
    additionalProperties: false,
  },
  // A different (lighter) model than the worker's by default: it reads, it doesn't build.
  model: "claude-sonnet-5-5",
  tokenBudget: null,
};
