/**
 * PR descriptions (`ralph.describe-pr` before the port): once every story of
 * a coding run is done, the run invokes this query task (trigger
 * `run.invoked`, the coding task's `prDescriptionTaskId`) to write the PR's
 * title and description. A read-only session in the run's branch worktree
 * studies the branch against its base; the `run-result` sink hands
 * `{ title, body }` back to the coding run, which opens or updates the PR.
 * The output schema is fixed; the control panel fits the title to
 * `MAX_PULL_REQUEST_TITLE_LENGTH` (`fitTitle`).
 */
import type { AgentDefinitionInput, TaskDefinitionInput } from "../definitions.js";

/** Longest title the prompt asks for (`PR_TITLE_MAX_LENGTH` in `@omniralph/ralph`). */
const PR_TITLE_MAX_LENGTH = 72;

/** Writes PR titles and descriptions; a copy of ralph's `PR_DESCRIPTION_SYSTEM_APPEND`. */
export const PR_WRITER_AGENT: AgentDefinitionInput = {
  id: "builtin:pr-writer",
  name: "PR writer",
  description:
    "Writes the title and description of a pull/merge request from the branch's commits and diff. Read-only.",
  systemPrompt: `You are "Omniralph", writing the title and description of a pull/merge request for work that is already committed.
- Only read: inspect the repository and git history (\`git log\`, \`git diff\`, \`git show\`). Don't edit files, commit, push, or run gh/glab.
- Report the title and description in your structured result (\`title\`, \`body\`).`,
  tools: { builtin: ["Read", "Grep", "Glob"], harness: [], linear: [], mcpServers: [] },
  taskTypes: ["query"],
};

const DESCRIBE_PR_TEMPLATE = `The branch \`{{branch}}\` in this git worktree is ready for a {{prTerm}} into \`{{baseBranch}}\`. It implements "{{epic.title}}" ({{epic.identifier}}).

{{#epic.prd}}
Background from the issue tracker (for context only; readers of the {{prTerm}} can't see it):
<issue-background>
{{epic.prd}}
</issue-background>

{{/epic.prd}}
{{#stories}}
The stories the branch implements, one commit each (Linear identifier, title, commit):
{{#items}}
- {{identifier}}: {{title}}{{#commit}} (\`{{commit}}\`){{/commit}}
{{/items}}

{{/stories}}
{{#qualityGates}}
Every story passed these quality gates before it was committed:
{{#items}}
- \`{{.}}\`
{{/items}}

{{/qualityGates}}
{{#progressLog}}
Notes from the sessions that did the work (decisions, gotchas):
<progress-log>
{{progressLog}}
</progress-log>

{{/progressLog}}
## Write the title and description
1. Study what actually changed: \`git log --reverse --format='%s%n%b' origin/{{baseBranch}}..HEAD\` and \`git diff origin/{{baseBranch}}...HEAD\` (use \`{{baseBranch}}\` instead of \`origin/{{baseBranch}}\` if that ref doesn't exist), reading files where the diff alone isn't clear.
2. Write a title and description for the {{prTerm}} that a reviewer with no access to the issue tracker can follow:
   - Title: one line, imperative mood, at most ${PR_TITLE_MAX_LENGTH} characters, summarising the change itself. No issue identifiers or prefixes.
   - Description (markdown): open with a short summary of what the change delivers and why. Then the notable changes, grouped by area, in a few bullets.
   - Add a **Stories** section listing every story above as \`- <identifier>: <title>\`, with the identifier exactly as given.
   - Add a **Verification** section saying how the change was verified (the quality gates above{{^qualityGates}}, if any{{/qualityGates}}, tests the stories added), without claiming checks that didn't run.
   - Add a **Breaking changes** section if behaviour, configuration, APIs or data formats change incompatibly, saying what users must do. Omit it otherwise.
   - Add a **Decisions** section for judgement calls, trade-offs or deviations from the request that a reviewer should know about. Omit it if there were none.
   - Don't describe the development process or the progress log, and don't link the issue tracker; that is added for you.
   - Be concrete and concise; don't pad with generic statements or restate the diff line by line.
3. Don't change any files.

Report them as the \`title\` and the markdown \`body\` of your structured result.`;

export const DESCRIBE_PR_TASK: TaskDefinitionInput = {
  id: "builtin:describe-pr",
  name: "Describe a PR",
  description:
    "Writes the title and description of a coding run's pull/merge request once every story is done.",
  taskType: "query",
  agentId: PR_WRITER_AGENT.id,
  triggers: ["run.invoked"],
  promptTemplate: DESCRIBE_PR_TEMPLATE,
  // The title isn't capped here: the control panel fits it (`fitTitle`).
  outputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "One line, imperative mood, at most ~70 characters.",
      },
      body: { type: "string", description: "The markdown description." },
    },
    required: ["title", "body"],
    additionalProperties: false,
  },
  sink: "run-result",
  // Ralph's story model (`DEFAULT_STORY_MODEL`). A run a ralph run invokes uses the repository's
  // `ralph_settings.model` (and `fallbackModel`) instead when it sets one (`resolveRunSpec`).
  model: "opus",
  tokenBudget: null,
};
