// Run questions and run details for the run components' tests, as `/api/ui` answers them.
import { TEST_ORGANIZATION_ID } from "@/components/query-test-utils";
import type { RunDetail, RunQuestion } from "@/lib/api/runs";
import { inboxItem, NOW } from "@/screens/inbox/test-fixtures";

const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

/** The ISO time `minutes` from the tests' now (negative: ago). */
export const NOW_AT = at;

/** One open question of each kind, with the options the server offers for it. */
export const QUESTIONS: Record<RunQuestion["kind"], RunQuestion> = {
  repository: {
    key: "question:run-1:repository",
    kind: "repository",
    prompt: "Which repo should Om work in for TOOL-42?",
    options: [
      { id: "repo-1", label: "acme/portal", provider: "gitlab" },
      { id: "repo-2", label: "acme/api", provider: "github" },
    ],
    askedAt: at(-30),
    expiresAt: null,
  },
  preparation: {
    key: "question:run-1:preparation",
    kind: "preparation",
    prompt:
      "TOOL-43 (Seed the bucket) is a manual story with preparation commands. Should Om run them now?",
    options: [
      { id: "run", label: "Run them now" },
      { id: "myself", label: "I'll run them myself" },
      { id: "later", label: "Ask me later" },
    ],
    askedAt: at(-30),
    expiresAt: null,
  },
  cleanup: {
    key: "question:run-1:cleanup",
    kind: "cleanup",
    prompt:
      "omniralph/tool-42 has 2 commits that weren't merged. Should Om push it to origin, or delete it? Without an answer, Om deletes it.",
    options: [
      { id: "push", label: "Push the branch" },
      { id: "delete", label: "Delete the branch" },
    ],
    askedAt: at(-30),
    expiresAt: at(120),
  },
  permission: {
    key: "question:run-1:permission",
    kind: "permission",
    prompt: "Om asks to use Bash: pnpm install",
    options: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    askedAt: at(-5),
    expiresAt: at(10),
  },
};

/** The Inbox `question` item of a run's open question. */
export function questionItem(question: RunQuestion, runId = "run-1") {
  return inboxItem({
    key: question.key,
    kind: "question",
    title: "Build the billing export",
    run: { id: runId, kind: "epic", status: "waiting" },
    reason: "Om is waiting on your answer.",
    actions: ["answer", "done", "snooze"],
    question,
  });
}

/** A waiting epic run's detail, asking `question`. */
export function runDetail(question: RunQuestion | null, overrides: Partial<RunDetail> = {}) {
  const detail: RunDetail = {
    id: "run-1",
    kind: "epic",
    status: "waiting",
    origin: "linear",
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    title: "Build the billing export",
    workItem: {
      tracker: "linear",
      identifier: "TOOL-42",
      url: "https://linear.app/acme/issue/TOOL-42",
    },
    repository: null,
    branch: null,
    pullRequest: null,
    agent: null,
    progress: { done: 0, total: 2 },
    tokens: { in: 0, out: 0 },
    createdAt: at(-60),
    startedAt: at(-60),
    finishedAt: null,
    updatedAt: at(-30),
    steps: [],
    attempts: [],
    details: {
      repository: null,
      branch: null,
      baseBranch: null,
      routedBy: null,
      agent: null,
      tokens: { in: 0, out: 0 },
      attemptCount: 0,
      pullRequest: null,
      lanes: [],
      error: null,
      waitingOn: null,
      question,
      actions: { stop: true, retry: { run: false, storyIds: [], attemptIds: [] } },
    },
    ...overrides,
  };
  return detail;
}

type Step = RunDetail["steps"][number];
type Attempt = RunDetail["attempts"][number];

const MINUTE_MS = 60_000;

/** An epic's story step. */
export function storyStep(
  id: string,
  status: Extract<Step, { kind: "story" }>["status"],
  durationMs = 0,
): Step {
  return {
    kind: "story",
    id,
    workItem: { tracker: "linear", identifier: `TOOL-${id}`, url: null },
    title: `Story ${id}`,
    status,
    attempts: durationMs > 0 ? 1 : 0,
    durationMs,
    commit: null,
    lastFeedback: null,
    lane: null,
  };
}

/** A finished (or failed) attempt of a run. */
export function attempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    label: `Built story ${id}`,
    type: "repo.sync",
    status: "completed",
    agent: null,
    deliveries: 1,
    cancelRequested: false,
    createdAt: at(-50),
    startedAt: at(-50),
    finishedAt: at(-40),
    tokens: { in: 0, out: 0 },
    error: null,
    step: null,
    transcriptEvents: 0,
    ...overrides,
  };
}

/** An epic of three stories: one done (13m), one running (5m), one pending. */
export function epicRunDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return runDetail(null, {
    status: "running",
    progress: { done: 1, total: 3 },
    steps: [
      storyStep("1", "completed", 13 * MINUTE_MS),
      storyStep("2", "running", 5 * MINUTE_MS),
      storyStep("3", "pending"),
    ],
    attempts: [attempt("a1", { step: "1", label: "Built TOOL-1" })],
    ...overrides,
  });
}

/** A running review: two passes (one done), and the correlation still queued. */
export function reviewRunDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  return runDetail(null, {
    id: "run-3",
    kind: "review",
    status: "running",
    origin: "pr_webhook",
    title: "Review !12",
    progress: null,
    steps: [
      {
        kind: "review_pass",
        id: "pass-1",
        taskName: "Security",
        status: "completed",
        tokens: { in: 0, out: 0 },
        durationMs: 45_000,
        openFindings: counts,
      },
      {
        kind: "review_pass",
        id: "pass-2",
        taskName: "Correctness",
        status: "running",
        tokens: { in: 0, out: 0 },
        durationMs: null,
        openFindings: counts,
      },
      {
        kind: "correlation",
        id: "corr-1",
        label: "Merge the passes' findings",
        status: "queued",
        tokens: { in: 0, out: 0 },
        durationMs: null,
      },
    ],
    ...overrides,
  });
}
