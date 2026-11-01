import { describe, expect, it } from "vitest";
import type { InboxItem } from "@/lib/api/inbox";
import {
  compactAge,
  durationSince,
  inboxItemLabel,
  openFindingsCount,
  relativeSince,
  relativeUntil,
} from "./labels";
import { inboxItem, NOW } from "./test-fixtures";

const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("compactAge", () => {
  it.each([
    [0, "now"],
    [59_000, "now"],
    [MIN, "1m"],
    [42 * MIN, "42m"],
    [HOUR, "1h"],
    [23 * HOUR + 59 * MIN, "23h"],
    [DAY, "1d"],
    [15 * DAY, "15d"],
  ])("%d ms ago reads %s", (ms, age) => {
    expect(compactAge(ago(ms), NOW)).toBe(age);
  });

  it("reads a future time as now", () => {
    expect(compactAge(new Date(NOW + HOUR).toISOString(), NOW)).toBe("now");
  });
});

describe("durationSince and relativeSince", () => {
  it.each([
    [30_000, "less than a minute", "just now"],
    [MIN, "1 minute", "1 minute ago"],
    [42 * MIN, "42 minutes", "42 minutes ago"],
    [HOUR, "1 hour", "1 hour ago"],
    [5 * HOUR, "5 hours", "5 hours ago"],
    [DAY, "1 day", "1 day ago"],
    [15 * DAY, "15 days", "15 days ago"],
  ])("%d ms: %s, %s", (ms, duration, relative) => {
    expect(durationSince(ago(ms), NOW)).toBe(duration);
    expect(relativeSince(ago(ms), NOW)).toBe(relative);
  });
});

describe("relativeUntil", () => {
  const ahead = (ms: number) => new Date(NOW + ms).toISOString();
  it.each([
    [-HOUR, "in less than a minute"],
    [30_000, "in less than a minute"],
    [42 * MIN, "in 42 minutes"],
    [2 * HOUR, "in 2 hours"],
    [3 * DAY, "in 3 days"],
  ])("%d ms ahead reads %s", (ms, relative) => {
    expect(relativeUntil(ahead(ms), NOW)).toBe(relative);
  });
});

describe("inboxItemLabel", () => {
  const since = ago(15 * DAY);
  const run = (kind: NonNullable<InboxItem["run"]>["kind"]) => ({
    id: "r",
    kind,
    status: "waiting" as const,
  });
  const WAITING = "Waiting on you for 15 days";
  const FAILED = "Failed 15 days ago";
  // Why it's here (the row line), what it is and its state (the dot's name), tone, status line.
  const cases: [string, Partial<InboxItem>, string | null, string, string, string][] = [
    [
      "manual_story",
      { kind: "manual_story" },
      "Manual story",
      "Epic, waiting on you",
      "need",
      WAITING,
    ],
    ["blocked_epic", { kind: "blocked_epic" }, "Blocked", "Epic, waiting on you", "need", WAITING],
    [
      "broken_relations",
      { kind: "broken_relations" },
      "Relations to fix",
      "Epic, waiting on you",
      "need",
      WAITING,
    ],
    [
      "question",
      { kind: "question", run: run("request") },
      "Question",
      "Request, waiting on you",
      "need",
      WAITING,
    ],
    [
      "stopped_epic",
      { kind: "stopped_epic", run: run("epic") },
      "Stopped",
      "Epic, stopped",
      "warn",
      WAITING,
    ],
    [
      "prd_ready",
      { kind: "prd_ready", run: run("triage") },
      "PRD ready",
      "Triage, waiting on you",
      "need",
      WAITING,
    ],
    [
      "prd_ready (open questions)",
      { kind: "prd_ready", run: run("triage"), openQuestions: 2 },
      "Needs answers",
      "Triage, waiting on you",
      "need",
      WAITING,
    ],
    [
      "pr_waiting (GitLab)",
      {
        kind: "pr_waiting",
        run: run("epic"),
        pullRequest: { provider: "gitlab", number: 1, url: null },
      },
      "MR ready for your review",
      "Epic, waiting on you",
      "need",
      WAITING,
    ],
    [
      "pr_waiting (GitHub)",
      {
        kind: "pr_waiting",
        run: run("epic"),
        pullRequest: { provider: "github", number: 1, url: null },
      },
      "PR ready for your review",
      "Epic, waiting on you",
      "need",
      WAITING,
    ],
    [
      "pr_waiting (GitHub, from the repo)",
      {
        kind: "pr_waiting",
        run: run("epic"),
        repository: { id: "r", provider: "github", fullPath: "acme/web" },
        pullRequest: null,
      },
      "PR ready for your review",
      "Epic, waiting on you",
      "need",
      WAITING,
    ],
    [
      "failed_run",
      { kind: "failed_run", run: run("review") },
      "Failed",
      "Review, failed",
      "fail",
      FAILED,
    ],
    [
      "failed_system",
      { kind: "failed_system", run: null },
      "Failed",
      "Background work, failed",
      "fail",
      FAILED,
    ],
    [
      "agent_offline",
      { kind: "agent_offline", run: null },
      "Agent offline",
      "Agent, offline",
      "fail",
      "Offline for 15 days",
    ],
    [
      "agent_update_failed",
      { kind: "agent_update_failed", run: null },
      "Agent update failed",
      "Agent, update failed",
      "fail",
      "Update failed 15 days ago",
    ],
    [
      "agent_update_failed (with its version)",
      { kind: "agent_update_failed", run: null, version: "1.4.0" },
      "Agent update failed",
      "Agent, update failed",
      "fail",
      "Update to 1.4.0 failed 15 days ago",
    ],
    // Running: the dot says it, so no row line.
    ["run", { kind: "run", run: run("ask") }, null, "Ask, running", "run", "Running for 15 days"],
  ];

  it.each(cases)("%s", (_name, overrides, rowLabel, statusLabel, tone, statusLine) => {
    expect(inboxItemLabel(inboxItem({ since, ...overrides }), NOW)).toEqual({
      rowLabel,
      statusLabel,
      tone,
      statusLine,
    });
  });

  it("covers every item kind", () => {
    const kinds = new Set(cases.map(([, overrides]) => overrides.kind));
    expect([...kinds].sort()).toEqual(
      [
        "manual_story",
        "blocked_epic",
        "broken_relations",
        "question",
        "stopped_epic",
        "prd_ready",
        "pr_waiting",
        "failed_run",
        "failed_system",
        "agent_offline",
        "agent_update_failed",
        "run",
      ].sort(),
    );
  });

  it("names each run kind in the dot", () => {
    for (const [kind, label] of [
      ["epic", "Epic"],
      ["request", "Request"],
      ["review", "Review"],
      ["triage", "Triage"],
      ["ask", "Ask"],
    ] as const) {
      expect(
        inboxItemLabel(inboxItem({ kind: "failed_run", run: run(kind) }), NOW).statusLabel,
      ).toBe(`${label}, failed`);
    }
  });
});

describe("openFindingsCount", () => {
  it("adds every severity, 0 without a review", () => {
    expect(openFindingsCount({ review: null })).toBe(0);
    expect(
      openFindingsCount({
        review: {
          runId: "r",
          status: "completed",
          openFindings: { critical: 1, high: 2, medium: 3, low: 4, info: 5 },
        },
      }),
    ).toBe(15);
  });
});
