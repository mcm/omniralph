import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RUN_KINDS } from "@/lib/api/runs";
import { linearEventName } from "@/lib/tracker/linear/ingest";
import { webhookEventName } from "@/lib/webhooks/ingest";
import { WEBHOOK_IGNORE_REASONS } from "@/lib/webhooks/reasons";
import { deliveryEventLabel, deliveryOutcomeText, OTHER_EVENT } from "./deliveries";

vi.mock("server-only", () => ({}));

const root = path.resolve(__dirname, "../../../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/**
 * Every action GitHub sends for each event the App can receive, and whether the delivery
 * carries a CI conclusion. The App subscribes to the manifest's `default_events`; the
 * test below fails when it subscribes to an event missing here.
 */
const GITHUB_ACTIONS: Record<string, readonly string[]> = {
  pull_request: [
    "opened",
    "reopened",
    "synchronize",
    "edited",
    "closed",
    "ready_for_review",
    "converted_to_draft",
    "review_requested",
    "review_request_removed",
    "assigned",
    "unassigned",
    "labeled",
    "unlabeled",
    "locked",
    "unlocked",
    "milestoned",
    "demilestoned",
    "auto_merge_enabled",
    "auto_merge_disabled",
    "enqueued",
    "dequeued",
  ],
  pull_request_review: ["submitted", "edited", "dismissed"],
  pull_request_review_comment: ["created", "edited", "deleted"],
  issue_comment: ["created", "edited", "deleted"],
  workflow_run: ["requested", "in_progress", "completed"],
  check_suite: ["requested", "rerequested", "completed"],
  check_run: ["created", "requested_action", "rerequested", "completed"],
  push: [],
};

const GITHUB_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "skipped",
  "action_required",
  "neutral",
  "stale",
  "startup_failure",
];

/** GitLab's hook names by the project webhook option that turns them on. */
const GITLAB_HOOKS: Record<string, { name: string; kind: string; actions: readonly string[] }> = {
  mergeRequestsEvents: {
    name: "Merge Request Hook",
    kind: "merge_request",
    actions: [
      "open",
      "reopen",
      "update",
      "close",
      "merge",
      "approved",
      "unapproved",
      "approval",
      "unapproval",
    ],
  },
  noteEvents: { name: "Note Hook", kind: "note", actions: ["create", "update"] },
  pipelineEvents: { name: "Pipeline Hook", kind: "pipeline", actions: [] },
  pushEvents: { name: "Push Hook", kind: "push", actions: [] },
};

const GITLAB_PIPELINE_STATUSES = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "success",
  "failed",
  "canceled",
  "skipped",
  "manual",
  "scheduled",
];

/** Linear's webhook types by the name its app settings give them (docs/linear.md). */
const LINEAR_TYPES: Record<string, { type: string; actions: readonly string[] }> = {
  "Agent session events": { type: "AgentSessionEvent", actions: ["created", "prompted"] },
  Issues: { type: "Issue", actions: ["create", "update", "remove"] },
  Comments: { type: "Comment", actions: ["create", "update", "remove"] },
};

function githubNames(): string[] {
  const manifest = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(read("docs/github-app.md"))![1]!);
  const subscribed: string[] = manifest.default_events;
  for (const event of subscribed) {
    expect(GITHUB_ACTIONS, `GitHub event ${event} has no actions listed`).toHaveProperty(event);
  }
  return Object.entries(GITHUB_ACTIONS).flatMap(([event, actions]) => {
    if (actions.length === 0) return [webhookEventName("github", event, {})];
    return actions.flatMap((action) => {
      const ci = ["workflow_run", "check_suite", "check_run"].includes(event);
      const bodies =
        ci && action === "completed"
          ? GITHUB_CONCLUSIONS.map((conclusion) => ({ action, [event]: { conclusion } }))
          : [{ action, ...(ci ? { [event]: { conclusion: null } } : {}) }];
      return bodies.map((body) => webhookEventName("github", event, body));
    });
  });
}

function gitlabNames(): string[] {
  const setup = read("packages/scm/src/gitlab/setup.ts");
  const enabled = [...setup.matchAll(/(\w+Events): true/g)].map((match) => match[1]!);
  expect(enabled.length).toBeGreaterThan(0);
  return enabled.flatMap((option) => {
    const hook = GITLAB_HOOKS[option];
    expect(hook, `GitLab webhook option ${option} has no hook listed`).toBeDefined();
    const { name, kind, actions } = hook!;
    if (kind === "pipeline") {
      return GITLAB_PIPELINE_STATUSES.map((status) =>
        webhookEventName("gitlab", name, { object_kind: kind, object_attributes: { status } }),
      );
    }
    return [
      webhookEventName("gitlab", name, { object_kind: kind, object_attributes: {} }),
      ...actions.map((action) =>
        webhookEventName("gitlab", name, { object_kind: kind, object_attributes: { action } }),
      ),
    ];
  });
}

function linearNames(): string[] {
  const row = /\| Webhook events \|([^\n]*)\|/.exec(read("docs/linear.md"))![1]!;
  const subscribed = [...row.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]!);
  expect(subscribed.length).toBeGreaterThan(0);
  for (const name of subscribed) {
    expect(LINEAR_TYPES, `Linear webhook ${name} has no type listed`).toHaveProperty(name);
  }
  return Object.values(LINEAR_TYPES).flatMap(({ type, actions }) =>
    actions.map((action) => linearEventName({ type, action })),
  );
}

describe("deliveryEventLabel", () => {
  it.each([
    ["github", githubNames],
    ["gitlab", gitlabNames],
    ["linear", linearNames],
  ] as const)("names every %s event the ingest records in plain words", (provider, names) => {
    const recorded = names();
    expect(recorded.length).toBeGreaterThan(5);
    for (const event of recorded) {
      const label = deliveryEventLabel(provider, event);
      expect(label, event).not.toBe(OTHER_EVENT);
      // Never the provider's own names.
      expect(label, event).not.toMatch(/_|Hook|Event\b|\.[a-z]/);
      expect(label, event).toMatch(/^[A-Z]/);
    }
  });

  it.each([
    ["github", "pull_request.synchronize", "Pull request · updated"],
    ["github", "pull_request.opened", "Pull request · opened"],
    ["github", "pull_request.ready_for_review", "Pull request · ready for review"],
    ["github", "pull_request_review.submitted", "Review · submitted"],
    ["github", "issue_comment.created", "Comment"],
    ["github", "issue_comment.edited", "Comment · edited"],
    ["github", "pull_request_review_comment.created", "Review comment"],
    ["github", "push", "Push"],
    ["github", "workflow_run.completed.failure", "CI · failed"],
    ["github", "workflow_run.completed.success", "CI · passed"],
    ["github", "workflow_run.completed", "CI · finished"],
    ["github", "workflow_run.requested", "CI · started"],
    ["github", "check_suite.completed.cancelled", "CI · canceled"],
    ["github", "check_run.rerequested", "CI · rerun requested"],
    ["gitlab", "Merge Request Hook.open", "Merge request · opened"],
    ["gitlab", "Merge Request Hook.update", "Merge request · updated"],
    ["gitlab", "Merge Request Hook.merge", "Merge request · merged"],
    ["gitlab", "Push Hook", "Push"],
    ["gitlab", "Note Hook", "Comment"],
    ["gitlab", "Note Hook.create", "Comment"],
    ["gitlab", "Pipeline Hook.failed", "CI · failed"],
    ["gitlab", "Pipeline Hook", "CI"],
    ["linear", "AgentSessionEvent.created", "Work item delegated"],
    ["linear", "AgentSessionEvent.prompted", "Reply in the session"],
    ["linear", "Issue.update", "Work item · updated"],
    ["linear", "Issue.create", "Work item · created"],
    ["linear", "Comment.create", "Comment"],
  ] as const)("%s %s reads %s", (provider, event, label) => {
    expect(deliveryEventLabel(provider, event)).toBe(label);
  });

  it("says pull request on GitHub and merge request on GitLab", () => {
    expect(deliveryEventLabel("github", "pull_request.closed")).toBe("Pull request · closed");
    expect(deliveryEventLabel("gitlab", "Merge Request Hook.close")).toBe("Merge request · closed");
  });

  it("falls back to the subject for an unknown action, and to Other event for anything unknown", () => {
    expect(deliveryEventLabel("github", "pull_request.teleported")).toBe("Pull request");
    expect(deliveryEventLabel("linear", "AgentSessionEvent.paused")).toBe("Agent session");
    for (const [provider, event] of [
      ["github", "unknown"],
      ["github", "deployment.created"],
      ["github", "Merge Request Hook.open"],
      ["gitlab", "pull_request.opened"],
      ["gitlab", "Wiki Page Hook"],
      ["linear", "Project.update"],
      ["linear", "unknown"],
      ["github", "constructor"],
      ["github", ""],
    ] as const) {
      expect(deliveryEventLabel(provider, event), `${provider} ${event}`).toBe(OTHER_EVENT);
    }
  });
});

describe("deliveryOutcomeText", () => {
  const base = {
    outcome: "started_run" as const,
    reason: null,
    run: null,
    replayOfId: null,
    replayedBy: null,
  };
  const run = (kind: (typeof RUN_KINDS)[number]) => ({ id: "run-1", kind });

  it.each([
    ["review", "Review started"],
    ["epic", "Epic started"],
    ["request", "Request started"],
    ["triage", "Triage started"],
    ["ask", "Question started"],
  ] as const)("a started %s run reads %s", (kind, text) => {
    expect(deliveryOutcomeText({ ...base, run: run(kind) })).toBe(text);
  });

  it("names the running run a delivery was sent to", () => {
    for (const [kind, noun] of [
      ["epic", "epic"],
      ["review", "review"],
      ["request", "request"],
      ["triage", "triage"],
    ] as const) {
      expect(deliveryOutcomeText({ ...base, outcome: "updated_run", run: run(kind) })).toBe(
        `Sent to the running ${noun}`,
      );
    }
    expect(deliveryOutcomeText({ ...base, outcome: "updated_run" })).toBe("Sent to its run");
  });

  it("gives the reason of an ignored or failed delivery", () => {
    expect(
      deliveryOutcomeText({
        ...base,
        outcome: "ignored",
        reason: WEBHOOK_IGNORE_REASONS.repository_disabled(),
      }),
    ).toBe("Ignored: reviews are off for this repo");
    expect(
      deliveryOutcomeText({
        ...base,
        outcome: "failed",
        reason: "No agent online for this repo.",
      }),
    ).toBe("Failed: no agent online for this repo");
    // Names keep their capital.
    expect(deliveryOutcomeText({ ...base, outcome: "ignored", reason: "Om's own review" })).toBe(
      "Ignored: Om's own review",
    );
    expect(
      deliveryOutcomeText({ ...base, outcome: "failed", reason: "GitLab rejected the token" }),
    ).toBe("Failed: GitLab rejected the token");
    expect(deliveryOutcomeText({ ...base, outcome: "ignored" })).toBe("Ignored");
    expect(deliveryOutcomeText({ ...base, outcome: "failed", reason: " " })).toBe("Failed");
  });

  it("says a duplicate was already handled", () => {
    expect(deliveryOutcomeText({ ...base, outcome: "duplicate" })).toBe("Already handled");
  });

  it("says who replayed a replay", () => {
    expect(
      deliveryOutcomeText({
        ...base,
        run: run("review"),
        replayOfId: "original",
        replayedBy: { id: "u1", name: "Ada" },
      }),
    ).toBe("Replayed by Ada: Review started");
    expect(
      deliveryOutcomeText({
        ...base,
        outcome: "failed",
        reason: "No agent online for this repo",
        replayOfId: "original",
        replayedBy: null,
      }),
    ).toBe("Replayed by someone: Failed: no agent online for this repo");
  });

  it("reads every ignore reason as a sentence after the colon", () => {
    for (const describe of Object.values(WEBHOOK_IGNORE_REASONS)) {
      const text = deliveryOutcomeText({ ...base, outcome: "ignored", reason: describe("github") });
      expect(text).toMatch(/^Ignored: \S/);
      expect(text).not.toMatch(/_/);
    }
  });
});
