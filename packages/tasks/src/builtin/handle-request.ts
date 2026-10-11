/**
 * Request runs (`ralph.request` before the port): one session doing what a
 * lane's pending requests ask (a mention in Linear, a chat request, review
 * findings, a failed CI run or a fix command) in the run's branch worktree.
 * The prompt is ralph's request prompt (`buildRequestPrompt` in
 * `@omniralph/ralph`) for both sources, both history-rewrite policies and
 * `/ship`, closed by the request-specific rules of ralph's request system
 * prompt (`requestSystemAppend`). Unlike today's request session, it can't
 * push: it publishes the branch through the `ship` harness tool (the push
 * instructions say so). A request run need not have an epic: the PRD, the
 * story list, its status and any other mention of epics or stories only
 * render in optional sections, for requests on a PRD epic's run.
 */
import type { TaskDefinitionInput } from "../definitions.js";
import { REQUEST_TRIGGERS } from "../kinds.js";
import { ENGINEER_AGENT } from "./engineer.js";

/** The request-specific rules of ralph's request system prompt, `/ship`'s included. */
export const REQUEST_RULES = `## Rules
{{#ship}}
You are shipping the work on a branch for {{#fromChat}}a chat thread{{/fromChat}}{{^fromChat}}a Linear agent session{{/fromChat}}.
- Don't run \`git commit\`, \`git push\`, \`git stash pop\`/\`drop\` or any command that rewrites history: the orchestrator commits everything left in the worktree with the \`commit.message\` of your structured result, then pushes the branch.
- Don't run \`gh\` or \`glab\`: they aren't set up here. Ask for pull/merge request changes (open, update) through \`pullRequest\` in your structured result; the orchestrator makes them after it pushes.
- The \`summary\` of your structured result is posted to {{#fromChat}}the chat thread{{/fromChat}}{{^fromChat}}the Linear thread{{/fromChat}}.
{{/ship}}
{{^ship}}
You are responding to a request in {{#fromChat}}a chat thread about a repository{{/fromChat}}{{^fromChat}}a Linear agent session{{/fromChat}}.
- Do what the request asks. You may commit when the request calls for it; push only through the \`ship\` tool.
- Don't run \`gh\` or \`glab\`: they aren't set up here. Ask for pull/merge request changes (open, update, mark ready) through \`pullRequest\` in your structured result; the orchestrator makes them.
- Only ship \`{{branch}}\`, the branch you are on. Never push to, or force-push, the base branch or any other branch.
{{#historyRewriteAllowed}}
- Don't rewrite history on your own initiative. When the request explicitly asks for it (rebase, squash, amend, reword), do it on \`{{branch}}\` and ship it with \`forceWithLease: true\`. That is allowed here.
{{/historyRewriteAllowed}}
{{^historyRewriteAllowed}}
- Never rewrite published history or force-push in this repository. If asked to rebase or squash, explain that it is disabled here and offer to merge the base branch instead.
{{/historyRewriteAllowed}}
- The \`summary\` of your structured result is posted to {{#fromChat}}the chat thread{{/fromChat}}{{^fromChat}}the Linear thread{{/fromChat}}: summarise what you did, with links (e.g. the PR/MR URL).
- To wait for background work, end your turn with \`waiting: true\` in your structured result.
{{/ship}}`;

/** "How to handle it" of an ordinary request (`requestInstructions`). */
const REQUEST_INSTRUCTIONS = `- This is a direct request{{^epic.single}}, not a story{{/epic.single}}. Do what it asks, and nothing beyond it.
- You may commit, and publish \`{{branch}}\` to \`origin\`, when the request calls for it. Don't run \`git push\` (your git credentials are read-only): call the \`ship\` tool, which commits what is left in the worktree with the \`message\` you give, pushes \`{{branch}}\` and tells you what it did. It never pushes \`{{baseBranch}}\` or any other branch.
{{#historyRewriteAllowed}}
- History rewrites are allowed on \`{{branch}}\` when the request asks for one. For a rebase: \`git fetch origin && git rebase origin/{{baseBranch}}\`, resolve conflicts, run the quality gates, then call \`ship\` with \`forceWithLease: true\`. Do the rebase that was asked for; don't substitute a merge. If the lease is rejected (someone else pushed), stop and report it instead of overwriting their work.
{{/historyRewriteAllowed}}
{{^historyRewriteAllowed}}
- History rewrites (rebase, squash, force-push) are disabled for this repository. If the request asks for one, say so and offer to merge \`{{baseBranch}}\` into \`{{branch}}\` instead.
{{/historyRewriteAllowed}}
{{#remoteUrl}}
- For the {{prTerm}}, don't run \`gh\` or \`glab\`. Ship \`{{branch}}\` first, then ask for it with \`pullRequest\`, on the \`ship\` call or in your structured result: \`open\` opens it into \`{{baseBranch}}\` as a draft, \`update\` changes the open one's title or description, \`ready\` marks it ready for review. Give \`open\` a title summarising the change itself and a description of the deliverable written for reviewers who can't see {{#fromChat}}the chat thread{{/fromChat}}{{^fromChat}}Linear{{/fromChat}}: what it does and why, notable changes, and any breaking changes or judgement calls.{{^fromChat}}{{^epic.single}} Don't list the user stories.{{/epic.single}}{{/fromChat}}
{{/remoteUrl}}
{{^remoteUrl}}
- There is no \`origin\` remote yet, so pushing or opening a pull/merge request isn't possible until one is added.
{{/remoteUrl}}
- If you change code, run the quality gates and commit with a clear message.
- If the request is ambiguous or can't be done (e.g. missing credentials), say exactly what's missing instead of guessing.
- Finish with a short summary for the {{#fromChat}}chat thread{{/fromChat}}{{^fromChat}}Linear thread{{/fromChat}} of what you did, including any {{prTerm}} URL, as the \`summary\` of your structured result.
`;

/** "How to handle it" of `/ship` (`shipInstructions`): the session prepares the commit. */
const SHIP_INSTRUCTIONS = `This is \`/ship\`: the work on \`{{branch}}\` is to be committed, pushed and put up for review. You prepare the commit; the orchestrator makes it with your message, pushes \`{{branch}}\` to \`origin\` and makes the {{prTerm}} change you ask for. Don't commit or push yourself.

1. See what the worktree has: \`git status\` and \`git diff\` (uncommitted changes), and \`git log --oneline origin/{{branch}}..HEAD\` (commits not pushed yet; the ref may not exist if the branch was never pushed).
{{#stashes}}
2. Earlier request sessions on this branch left uncommitted work, which was stashed (newest first):
{{#items}}
   - \`{{sha}}\` ({{date}}): {{label}}
{{/items}}
   Review each with \`git stash show -p --include-untracked <sha>\` and bring back what belongs in this commit with \`git stash apply <sha>\`. Never \`pop\` or \`drop\` them: the stash list is shared with other worktrees.
{{/stashes}}
{{^stashes}}
2. No earlier request session left stashed work on this branch.
{{/stashes}}
3. If the request above says more than \`/ship\` (notes, a last fix), do that first.
{{#qualityGates}}
4. Run the quality gates ({{inline}}) and fix any failures.
{{/qualityGates}}
{{^qualityGates}}
4. Check that the change builds and its tests pass, as far as the repository lets you.
{{/qualityGates}}
5. Leave in the worktree only what belongs in the commit: everything left (including untracked files) is committed with \`git add -A\`. Delete scratch files; add generated ones to \`.gitignore\`.
6. Report \`commit.message\` in your structured result: a one-line subject, a blank line, and a short body saying what changed and why. Leave \`commit\` out when there's nothing to commit (the orchestrator still pushes commits that aren't on \`origin\` yet).
{{#prUrl}}
7. The {{prTerm}} is open ({{prUrl}}). If its title or description no longer match the branch, set \`pullRequest\` to \`update\` with a new title and description; otherwise leave \`pullRequest\` out.
{{/prUrl}}
{{^prUrl}}
7. No {{prTerm}} is open yet: set \`pullRequest\` to \`open\` with a title summarising the change itself and a description written for reviewers who can't see {{#fromChat}}the chat thread{{/fromChat}}{{^fromChat}}Linear{{/fromChat}} (what it does and why, notable changes, breaking changes or judgement calls).{{^fromChat}}{{^epic.single}} Don't list the user stories.{{/epic.single}}{{/fromChat}}
{{/prUrl}}
- If something stops you (failing gates you can't fix, a conflict, missing credentials), leave \`commit\` out and say exactly what's wrong in \`summary\`: nothing is committed or pushed then.
- \`summary\` is posted to the {{#fromChat}}chat{{/fromChat}}{{^fromChat}}Linear{{/fromChat}} thread: say what is being committed and pushed, in a sentence or two.
`;

// Requests are fenced one by one instead of quoted line by line (\`> \`) as in today's prompt.
const REQUEST_TEMPLATE = `{{#fromChat}}
You are working on a request from a chat thread: {{epic.title}}.
It is implemented on branch \`{{branch}}\` (base \`{{baseBranch}}\`) in this git worktree.
{{/fromChat}}
{{^fromChat}}
You are working on Linear {{epic.identifier}}: {{epic.title}}.
{{#epic.single}}
It is implemented on branch \`{{branch}}\` (base \`{{baseBranch}}\`) in this git worktree.
{{/epic.single}}
{{^epic.single}}
It is a PRD epic implemented one story per commit on branch \`{{branch}}\` (base \`{{baseBranch}}\`) in this git worktree.
{{/epic.single}}
{{/fromChat}}
{{^epic.single}}
{{#stories}}

## Status: {{completed}}/{{total}} stories complete
{{#items}}
- {{mark}} {{identifier}}: {{title}}{{#manual}} (manual step for a person, not for you){{/manual}}{{^manual}}{{#repository}} (in {{repository}}){{/repository}}{{/manual}}{{#dependsOn}} (depends on {{dependsOn}}){{/dependsOn}}
{{/items}}
{{^items}}

{{/items}}
{{/stories}}
{{/epic.single}}

- Git remote \`origin\`: {{#remoteUrl}}\`{{remoteUrl}}\`{{/remoteUrl}}{{^remoteUrl}}none configured{{/remoteUrl}}
- {{prTermCapitalized}}: {{#prUrl}}{{prUrl}}{{/prUrl}}{{^prUrl}}none opened yet{{/prUrl}}
- Progress log (learnings from earlier sessions): \`{{progressFile}}\`
{{#qualityGates}}
- Quality gates: {{inline}}
{{/qualityGates}}
{{#epic.prd}}

<prd-document>
{{epic.prd}}
</prd-document>
{{/epic.prd}}
{{#attachments}}

## Attachments
Files attached {{#fromChat}}to the request{{/fromChat}}{{^fromChat}}in Linear{{/fromChat}}. Open the ones relevant to the request with the Read tool (it shows images):
{{attachments}}
{{/attachments}}

## Request from your team
{{#requests}}
{{.}}

{{/requests}}
## How to handle it
{{#ship}}
${SHIP_INSTRUCTIONS}{{/ship}}
{{^ship}}
${REQUEST_INSTRUCTIONS}{{/ship}}
{{#appendInstruction}}

{{appendInstruction}}
{{/appendInstruction}}

${REQUEST_RULES}`;

export const HANDLE_REQUEST_TASK: TaskDefinitionInput = {
  id: "builtin:handle-request",
  name: "Handle a request",
  description:
    "Does what a run's pending requests ask (a mention, a chat request, review findings, a failed CI run, a fix command or /ship) in the run's branch worktree.",
  taskType: "coding",
  agentId: ENGINEER_AGENT.id,
  triggers: [...REQUEST_TRIGGERS],
  promptTemplate: REQUEST_TEMPLATE,
  toolSettings: { shell: true, linearRead: false, network: true },
  // Handed back to the ralph run, which posts the summary and makes the PR change.
  sink: "ralph-run",
  pool: "long",
  // Ralph's story model (`DEFAULT_STORY_MODEL`); the repository's `ralph_settings.model` overrides it.
  model: "opus",
  tokenBudget: null,
};
