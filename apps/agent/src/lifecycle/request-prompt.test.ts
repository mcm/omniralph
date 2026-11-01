/**
 * The prompts of `builtin:handle-request` coding runs outside an epic: for
 * every request trigger on a run that has no PRD epic (a single delegated
 * issue, an @mention, a chat thread), the rendered prompt and the
 * `builtin:engineer` system prompt never talk about epics, PRDs or stories.
 * The trigger contexts are shaped like the `RalphRequestPayload`s `advanceRun`
 * builds (`buildRequestPayload`), with request
 * texts from the builders the control panel uses.
 */
import { randomUUID } from "node:crypto";
import { buildCiFailureRequest, buildReviewRequest } from "@omniralph/ralph";
import { RalphRequestPayload, RunSpec } from "@omniralph/shared";
import { getBuiltinRunSpec, getBuiltinTask, type REQUEST_TRIGGERS } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { requestRunPrompt } from "./coding.js";
import { querySystemPrompt } from "./query.js";

const engineer = getBuiltinRunSpec("builtin:implement-story")!.agent;
const requestTask = getBuiltinTask("builtin:handle-request")!;

type RequestTrigger = (typeof REQUEST_TRIGGERS)[number];

const EPIC_WORDING = /\b(epic|PRD|stor(y|ies))\b/i;
const PROGRESS_FILE = "/tmp/omniralph-progress-q/progress.md";
const BRANCH = "eng-7-fix-the-date-picker";
const PR_URL = "https://github.com/acme/widgets/pull/42";

/** A single delegated issue's run: the issue is its only (in-progress) item. */
const SINGLE_ISSUE = {
  source: "tracker",
  epic: {
    identifier: "ENG-7",
    title: "Fix the date picker",
    kind: "single",
    url: "https://linear.app/acme/issue/ENG-7",
    prd: "",
  },
  stories: [{ identifier: "ENG-7", title: "Fix the date picker", status: "in_progress" }],
} as const;

/** A run started by an @mention on an issue: also a single issue. */
const MENTIONED_ISSUE = {
  source: "tracker",
  epic: { identifier: "ENG-8", title: "Tidy the settings page", kind: "single", prd: "" },
  stories: [{ identifier: "ENG-8", title: "Tidy the settings page", status: "in_progress" }],
} as const;

/** A chat run (`chatRequestEpic`): no work item, no item list. */
const CHAT_THREAD = {
  source: "chat",
  epic: { identifier: "chat-3f2a", title: "Bump the Node version", kind: "single", prd: "" },
  stories: [],
} as const;

interface TriggerCase {
  name: string;
  trigger: RequestTrigger;
  payload: Record<string, unknown>;
  requests: string[];
}

const CASES: TriggerCase[] = [
  {
    name: "a request on a single delegated issue's run",
    trigger: "tracker.mention",
    payload: SINGLE_ISSUE,
    requests: ["Please also show the time zone next to the date."],
  },
  {
    name: "an @mention",
    trigger: "tracker.mention",
    payload: MENTIONED_ISSUE,
    requests: ["@omniralph move the save button to the top of the page."],
  },
  {
    name: "a chat responder call",
    trigger: "chat.request",
    payload: CHAT_THREAD,
    requests: [
      "Bump Node to 24 and open a PR.\n\nFrom the chat thread:\n\n> **sam:** CI still uses Node 20.",
    ],
  },
  {
    name: "review findings",
    trigger: "pr.review-findings",
    payload: { ...SINGLE_ISSUE, prUrl: PR_URL },
    requests: [
      buildReviewRequest({
        findings: [
          {
            id: "f-1",
            path: "src/date-picker.ts",
            startLine: 12,
            severity: "major",
            title: "The offset is applied twice",
            body: "`toLocal` already applies the offset.",
            suggestion: "return toLocal(date);",
          },
        ],
        prNumber: 42,
        prUrl: PR_URL,
        branch: BRANCH,
      }),
    ],
  },
  {
    name: "failed CI",
    trigger: "pr.ci-failed",
    payload: { ...SINGLE_ISSUE, prUrl: PR_URL },
    requests: [
      buildCiFailureRequest({
        prNumber: 42,
        prUrl: PR_URL,
        headSha: "a".repeat(40),
        branch: BRANCH,
        jobs: [{ name: "test", url: null, log: "FAIL src/date-picker.test.ts" }],
      }),
    ],
  },
  {
    name: "@bot fix",
    trigger: "pr.fix-command",
    payload: { ...SINGLE_ISSUE, prUrl: PR_URL },
    requests: ["fix the flaky date-picker test"],
  },
];

function payloadOf(c: TriggerCase, ship: boolean): RalphRequestPayload {
  const requests = ship ? [...c.requests, "/ship"] : c.requests;
  const branch = c.payload.source === "chat" ? "omniralph/chat-3f2a" : BRANCH;
  return RalphRequestPayload.parse({
    runId: randomUUID(),
    repositoryId: randomUUID(),
    repository: {
      provider: "github",
      fullPath: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
    },
    branch,
    baseBranch: "main",
    settings: { model: null, setupCommand: null },
    requests: requests.map((text) => ({ id: randomUUID(), text })),
    progress: "# Ralph Progress Log\n",
    qualityGates: ["pnpm test", "pnpm lint"],
    attachments: [],
    ship,
    ...c.payload,
  });
}

/** The run spec of a `builtin:handle-request` coding run of `payload`. */
function specOf(trigger: RequestTrigger, payload: RalphRequestPayload): RunSpec {
  const jobId = randomUUID();
  const token = (kind: "lifecycle" | "session") => ({
    jobId,
    token: `${kind}-token`,
    expiresIn: 600,
    kind,
  });
  return RunSpec.parse({
    jobId,
    taskType: "coding",
    pool: "long",
    agent: engineer,
    task: requestTask,
    trigger: { kind: trigger, context: payload },
    repository: payload.repository,
    ref: null,
    requireCheckout: false,
    tools: { allowedTools: [], disallowedTools: [] },
    model: "opus",
    fallbackModel: null,
    tokenBudget: null,
    tokens: { lifecycle: token("lifecycle"), session: token("session") },
  });
}

function render(c: TriggerCase, ship: boolean) {
  const payload = payloadOf(c, ship);
  const spec = specOf(c.trigger, payload);
  const prompt = requestRunPrompt(spec, payload, {
    progressFile: PROGRESS_FILE,
    shipStashes: ship
      ? [
          {
            sha: "b".repeat(40),
            label: "omniralph ralph run-1 request pre-run",
            date: "2026-10-10",
          },
        ]
      : [],
  });
  return { payload, prompt, system: querySystemPrompt(spec) };
}

describe("builtin:handle-request outside an epic", () => {
  describe.each([false, true])("ship: %s", (ship) => {
    it.each(CASES)("never mentions epics, PRDs or stories ($name)", (c) => {
      const { prompt, system } = render(c, ship);
      expect(system).toEqual({ systemAppend: engineer.systemPrompt });
      expect(system.systemAppend).not.toMatch(EPIC_WORDING);
      expect(prompt.match(EPIC_WORDING)).toBeNull();
    });

    it.each(CASES)("names the branches, gates and requests, and how to push ($name)", (c) => {
      const { payload, prompt } = render(c, ship);
      expect(prompt).toContain(`\`${payload.branch}\` (base \`main\`)`);
      expect(prompt).toContain("- Quality gates: `pnpm test`, `pnpm lint`");
      for (const request of payload.requests) expect(prompt).toContain(request.text.trim());
      expect(prompt).not.toMatch(/git push (-u|--force-with-lease)/);
      if (ship) {
        // `/ship`: the session doesn't push at all, the lifecycle ships after it.
        expect(prompt).toContain(
          `the orchestrator makes it with your message, pushes \`${payload.branch}\` to \`origin\``,
        );
        expect(prompt).toContain("Don't commit or push yourself.");
      } else {
        expect(prompt).toContain(
          "Don't run `git push` (your git credentials are read-only): call the `ship` tool",
        );
      }
    });
  });

  it("still renders the PRD and the item status on a PRD epic's run", () => {
    const epicRun: TriggerCase = {
      name: "a request on a PRD epic's run",
      trigger: "tracker.mention",
      payload: {
        source: "tracker",
        epic: {
          identifier: "ENG-10",
          title: "Widget exports",
          kind: "children",
          prd: "## Introduction\nAdmins want to export widgets.",
        },
        stories: [
          { identifier: "ENG-11", title: "Widgets table", status: "completed" },
          { identifier: "ENG-12", title: "Export widgets as CSV", status: "in_progress" },
        ],
      },
      requests: ["Please rebase onto main."],
    };
    const { prompt } = render(epicRun, false);
    expect(prompt).toContain("It is a PRD epic implemented one story per commit");
    expect(prompt).toContain("## Status: 1/2 stories complete");
    expect(prompt).toContain("Admins want to export widgets.");
    expect(prompt).toContain("This is a direct request, not a story.");
  });
});
