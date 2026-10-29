import { describe, expect, it } from "vitest";
import type { InboxItem } from "@/lib/api/inbox";
import { compactAge, durationSince, inboxItemLabel, relativeSince, relativeUntil } from "./labels";
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
  const cases: [string, Partial<InboxItem>, string, string, string][] = [
    [
      "manual_story",
      { kind: "manual_story" },
      "Epic · manual story",
      "need",
      "Waiting on you for 15 days",
    ],
    [
      "blocked_epic",
      { kind: "blocked_epic" },
      "Epic · blocked",
      "need",
      "Waiting on you for 15 days",
    ],
    [
      "question",
      { kind: "question", run: run("request") },
      "Request · question",
      "need",
      "Waiting on you for 15 days",
    ],
    [
      "stopped_epic",
      { kind: "stopped_epic", run: run("epic") },
      "Epic · stopped",
      "need",
      "Waiting on you for 15 days",
    ],
    [
      "prd_ready",
      { kind: "prd_ready", run: run("triage") },
      "Triage · PRD ready",
      "need",
      "Waiting on you for 15 days",
    ],
    [
      "pr_waiting (GitLab)",
      {
        kind: "pr_waiting",
        pullRequest: { provider: "gitlab", number: 1, url: null },
        reviewState: "review_requested",
      },
      "Merge request · review requested",
      "need",
      "Waiting on you for 15 days",
    ],
    [
      "pr_waiting (GitHub)",
      {
        kind: "pr_waiting",
        repository: { id: "r", provider: "github", fullPath: "acme/web" },
        pullRequest: { provider: "github", number: 1, url: null },
        reviewState: "changes_requested",
      },
      "Pull request · changes requested",
      "need",
      "Waiting on you for 15 days",
    ],
    [
      "pr_waiting (GitHub, from the repo)",
      {
        kind: "pr_waiting",
        repository: { id: "r", provider: "github", fullPath: "acme/web" },
        pullRequest: null,
        reviewState: "approved",
      },
      "Pull request · approved",
      "need",
      "Waiting on you for 15 days",
    ],
    [
      "failed_run",
      { kind: "failed_run", run: run("review") },
      "Review · failed",
      "fail",
      "Failed 15 days ago",
    ],
    [
      "failed_system",
      { kind: "failed_system", run: null },
      "Background work · failed",
      "fail",
      "Failed 15 days ago",
    ],
    [
      "agent_offline",
      { kind: "agent_offline", run: null },
      "Agent · offline",
      "fail",
      "Offline for 15 days",
    ],
    [
      "agent_update_failed",
      { kind: "agent_update_failed", run: null },
      "Agent · update failed",
      "fail",
      "Update failed 15 days ago",
    ],
    [
      "agent_update_failed (with its version)",
      { kind: "agent_update_failed", run: null, version: "1.4.0" },
      "Agent · update failed",
      "fail",
      "Update to 1.4.0 failed 15 days ago",
    ],
    ["run", { kind: "run", run: run("ask") }, "Ask · running", "run", "Running for 15 days"],
    [
      "run (queued: waiting for an agent)",
      { kind: "run", run: { id: "r", kind: "triage", status: "queued" } },
      "Triage · queued",
      "run",
      "Queued for 15 days",
    ],
  ];

  it.each(cases)("%s", (_name, overrides, rowLabel, tone, statusLine) => {
    expect(inboxItemLabel(inboxItem({ since, ...overrides }), NOW)).toEqual({
      rowLabel,
      tone,
      statusLine,
    });
  });

  it("names a PR/MR's every review state, and one without a state as waiting for review", () => {
    const label = (reviewState: InboxItem["reviewState"]) =>
      inboxItemLabel(inboxItem({ kind: "pr_waiting", reviewState }), NOW).rowLabel;
    expect(label("none")).toBe("Merge request · waiting for review");
    expect(label("commented")).toBe("Merge request · commented");
    expect(label(null)).toBe("Merge request · waiting for review");
  });

  it("covers every item kind", () => {
    const kinds = new Set(cases.map(([, overrides]) => overrides.kind));
    expect([...kinds].sort()).toEqual(
      [
        "manual_story",
        "blocked_epic",
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

  it("names each run kind", () => {
    for (const [kind, label] of [
      ["epic", "Epic"],
      ["request", "Request"],
      ["review", "Review"],
      ["triage", "Triage"],
      ["ask", "Ask"],
    ] as const) {
      expect(inboxItemLabel(inboxItem({ kind: "failed_run", run: run(kind) }), NOW).rowLabel).toBe(
        `${label} · failed`,
      );
    }
  });
});
