// Inbox items for the Inbox's tests, as `GET /api/ui/inbox` answers them.
import { TEST_ORGANIZATION_ID } from "@/components/query-test-utils";
import type { InboxCountsResponse, InboxItem } from "@/lib/api/inbox";
import type { WorkItemDetail } from "@/lib/api/work-items";

export const NOW = Date.parse("2026-10-26T12:00:00.000Z");
export const BETA_ID = "22222222-2222-4222-8222-222222222222";

const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** A manual story waiting 15 days, with overrides. */
export function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    key: "manual_story:s1",
    tab: "needs-you",
    kind: "manual_story",
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    title: "Rotate the staging certificates",
    run: { id: "run-1", kind: "epic", status: "waiting" },
    workItem: {
      tracker: "linear",
      id: "linear-story-42",
      identifier: "TOOL-42",
      url: "https://linear.app/acme/issue/TOOL-42",
    },
    epic: {
      tracker: "linear",
      id: "linear-epic-40",
      identifier: "TOOL-40",
      url: "https://linear.app/acme/issue/TOOL-40",
    },
    repository: { id: "repo-1", provider: "gitlab", fullPath: "acme/portal" },
    pullRequest: null,
    agent: null,
    reason: "Om can't do this story: it needs access to the certificate store.",
    reasonLink: null,
    since: minutesAgo(15 * 24 * 60),
    actions: ["done", "skip", "snooze"],
    question: null,
    reviewState: null,
    review: null,
    size: null,
    openQuestions: 0,
    version: null,
    ...overrides,
  };
}

/** A GitLab merge request ready for review, with 3 open findings. */
export function mrReadyItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return inboxItem({
    key: "pr_waiting:lane-1",
    kind: "pr_waiting",
    title: "Add the billing export",
    run: { id: "run-2", kind: "epic", status: "completed" },
    epic: null,
    pullRequest: {
      provider: "gitlab",
      number: 12,
      url: "https://gitlab.com/acme/portal/-/merge_requests/12",
    },
    reason: "The merge request is ready for your review.",
    since: minutesAgo(42),
    actions: ["done", "snooze"],
    reviewState: "review_requested",
    review: {
      runId: "run-3",
      status: "completed",
      openFindings: { critical: 0, high: 1, medium: 2, low: 0, info: 0 },
    },
    ...overrides,
  });
}

/** An agent offline for 2 hours. */
export function agentOfflineItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return inboxItem({
    key: "agent_offline:agent-1",
    tab: "problems",
    kind: "agent_offline",
    title: "build-box is offline",
    run: null,
    workItem: null,
    epic: null,
    repository: null,
    agent: { id: "agent-1", name: "build-box" },
    reason: "build-box hasn't checked in for 2 hours.",
    since: minutesAgo(120),
    actions: ["done", "snooze"],
    ...overrides,
  });
}

/** A running epic, started `minutes` ago. */
export function runningItem(id: string, title: string, minutes: number): InboxItem {
  return inboxItem({
    key: `run:${id}`,
    tab: "running",
    kind: "run",
    title,
    run: { id, kind: "epic", status: "running" },
    epic: null,
    reason: "Om is working on it.",
    since: minutesAgo(minutes),
    actions: [],
  });
}

export const COUNTS: InboxCountsResponse = { needsYou: 2, problems: 1, running: 0, questions: 0 };

/** The manual story's work item detail (`GET /api/ui/work-items/linear-story-42`), with overrides. */
export function storyDetail(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    id: "linear-story-42",
    tracker: "linear",
    identifier: "TOOL-42",
    title: "Rotate the staging certificates",
    url: "https://linear.app/acme/issue/TOOL-42",
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    repository: null,
    kind: "story",
    size: null,
    group: null,
    blocked: false,
    blockers: [],
    blockedLabels: [],
    source: { kind: "team", id: "team-1", name: "TOOL" },
    state: { category: "todo", name: "Todo" },
    description: "Rotate them.\n\n- [x] Export the old cert\n- [ ] Install the new one\n",
    updatedAt: "2026-10-26T10:00:00.000Z",
    blockedBy: [],
    route: { outcome: "manual", repository: null, via: null, by: null },
    stories: [],
    activity: [],
    triageRunning: false,
    triageQuestions: null,
    run: null,
    actions: {
      start: false,
      triage: false,
      editPrd: true,
      changeRepo: false,
      move: false,
      cancel: true,
    },
    manual: true,
    manualLabels: ["manual"],
    ...overrides,
  };
}
