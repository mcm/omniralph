import { describe, expect, it } from "vitest";
import {
  INBOX_ACTIONS,
  INBOX_SNOOZE_MAX_MS,
  INBOX_SNOOZE_MIN_MS,
  type InboxItem,
} from "@/lib/api/inbox";
import {
  agentOfflineItem,
  inboxItem,
  mrReadyItem,
  runningItem,
} from "@/screens/inbox/test-fixtures";
import { inboxCtas, SNOOZE_CHOICES, snoozeUntil } from "./decisions";

const ALL = [...INBOX_ACTIONS];

/** Each call to action as `[label, variant]`, plus where a link goes. */
const ctas = (item: InboxItem) =>
  inboxCtas(item).map((cta) =>
    cta.type === "link" ? [cta.label, cta.variant, cta.href] : [cta.label, cta.variant],
  );

/** An item of `kind` about run-1 and its work item, offering every action. */
const itemOf = (kind: InboxItem["kind"], overrides: Partial<InboxItem> = {}) =>
  mrReadyItem({ kind, pullRequest: null, actions: ALL, ...overrides });

describe("inboxCtas", () => {
  it("a PR waiting on review leads with Open PR/MR, then View PRD; Dismiss and Snooze are quiet", () => {
    expect(ctas(mrReadyItem())).toEqual([
      ["Open MR", "primary", "https://gitlab.com/acme/portal/-/merge_requests/12"],
      ["View PRD", "outline"],
      ["Dismiss", "ghost"],
      ["Snooze", "ghost"],
    ]);
    const github = mrReadyItem({
      pullRequest: { provider: "github", number: 3, url: "https://github.com/acme/portal/pull/3" },
    });
    expect(ctas(github)[0]).toEqual([
      "Open PR",
      "primary",
      "https://github.com/acme/portal/pull/3",
    ]);
  });

  it("a PR waiting on review whose URL is unknown falls back to Dismiss as the primary", () => {
    expect(ctas(mrReadyItem({ pullRequest: null }))).toEqual([
      ["Dismiss", "primary"],
      ["View PRD", "outline"],
      ["Snooze", "ghost"],
    ]);
  });

  it("an open PR link opens in a new tab; the app's own links don't", () => {
    const links = inboxCtas(itemOf("failed_run")).concat(inboxCtas(mrReadyItem()));
    expect(links.flatMap((cta) => (cta.type === "link" ? [[cta.step, cta.external]] : []))).toEqual(
      [
        ["open_run", false],
        ["open_pr", true],
      ],
    );
  });

  it("a manual story: Done, resume epic first, and View PRD opens its epic's PRD", () => {
    const item = inboxItem();
    expect(ctas(item)).toEqual([
      ["Done, resume epic", "primary"],
      ["Skip story", "outline"],
      ["View PRD", "outline"],
      ["Snooze", "ghost"],
    ]);
    const prd = inboxCtas(item).find((cta) => cta.type === "prd");
    expect(prd).toMatchObject({
      runId: "run-1",
      workItem: { id: "linear-epic-40", identifier: "TOOL-40" },
    });
  });

  it("a ready PRD leads with Review PRD, then its work item's page", () => {
    expect(ctas(itemOf("prd_ready"))).toEqual([
      ["Review PRD", "primary"],
      ["Open work item", "outline", "/backlog/linear-story-42"],
      ["Dismiss", "ghost"],
      ["Snooze", "ghost"],
    ]);
  });

  it("a failed run: Retry, Open run and View PRD, then Dismiss and Snooze", () => {
    expect(ctas(itemOf("failed_run"))).toEqual([
      ["Retry", "primary"],
      ["Open run", "outline", "/runs/run-2"],
      ["View PRD", "outline"],
      ["Dismiss", "ghost"],
      ["Snooze", "ghost"],
    ]);
  });

  it("a stopped epic: Resume, Open run and View PRD", () => {
    expect(ctas(itemOf("stopped_epic")).map(([label]) => label)).toEqual([
      "Resume",
      "Open run",
      "View PRD",
      "Dismiss",
      "Snooze",
    ]);
  });

  it("a blocked epic and a question lead with their own decision", () => {
    expect(ctas(itemOf("blocked_epic"))[0]).toEqual(["Start anyway", "primary"]);
    expect(ctas(itemOf("question"))[0]).toEqual(["Send answer", "primary"]);
  });

  it("an agent leads with Open agent", () => {
    expect(ctas(agentOfflineItem())).toEqual([
      ["Open agent", "primary", "/fleet/agent-1"],
      ["Dismiss", "ghost"],
      ["Snooze", "ghost"],
    ]);
  });

  it("failed system work that can't be retried: Dismiss is the primary", () => {
    const item = agentOfflineItem({
      kind: "failed_system",
      agent: null,
      actions: ["done", "snooze"],
    });
    expect(ctas(item)).toEqual([
      ["Dismiss", "primary"],
      ["Snooze", "ghost"],
    ]);
  });

  it("a running run offers View PRD and Open run, neither primary", () => {
    expect(ctas(runningItem("run-9", "Billing", 5))).toEqual([
      ["View PRD", "outline"],
      ["Open run", "outline", "/runs/run-9"],
    ]);
  });

  it("offers View PRD only with a run and a work item", () => {
    const steps = (item: InboxItem) => inboxCtas(item).map((cta) => cta.label);
    expect(steps(itemOf("failed_run", { workItem: null }))).not.toContain("View PRD");
    expect(steps(inboxItem({ epic: null }))).not.toContain("View PRD");
    expect(steps(itemOf("failed_system", { run: null }))).not.toContain("View PRD");
  });

  it("shows a decision only when the item's actions include it", () => {
    expect(ctas(inboxItem({ actions: ["skip", "snooze"] }))).toEqual([
      ["Skip story", "primary"],
      ["View PRD", "outline"],
      ["Snooze", "ghost"],
    ]);
    expect(ctas(itemOf("failed_run", { actions: ["done"] }))).toEqual([
      ["Dismiss", "primary"],
      ["Open run", "outline", "/runs/run-2"],
      ["View PRD", "outline"],
    ]);
  });
});

describe("snoozeUntil", () => {
  // Local times: the snooze is in the user's own time zone.
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts);

  it("1 hour: an hour from now", () => {
    const now = at(2026, 9, 26, 14, 30);
    expect(snoozeUntil("hour", now).getTime()).toBe(now.getTime() + 3_600_000);
  });

  it("Tomorrow: 9:00 the next day, also when it's already past 9:00", () => {
    expect(snoozeUntil("tomorrow", at(2026, 9, 26, 14, 30))).toEqual(at(2026, 9, 27, 9, 0));
    expect(snoozeUntil("tomorrow", at(2026, 9, 26, 7, 0))).toEqual(at(2026, 9, 27, 9, 0));
    // Across a month's end.
    expect(snoozeUntil("tomorrow", at(2026, 9, 31, 23, 0))).toEqual(at(2026, 10, 1, 9, 0));
  });

  it("Next week: 9:00 next Monday", () => {
    // Sunday evening: tomorrow's Monday.
    const sunday = at(2026, 9, 25, 21, 0);
    expect(sunday.getDay()).toBe(0);
    expect(snoozeUntil("next-week", sunday)).toEqual(at(2026, 9, 26, 9, 0));
    // A Monday: the following Monday.
    expect(snoozeUntil("next-week", at(2026, 9, 26, 8, 0))).toEqual(at(2026, 10, 2, 9, 0));
    // Wednesday and Saturday.
    expect(snoozeUntil("next-week", at(2026, 9, 28, 12, 0))).toEqual(at(2026, 10, 2, 9, 0));
    expect(snoozeUntil("next-week", at(2026, 9, 31, 12, 0))).toEqual(at(2026, 10, 2, 9, 0));
  });

  it("always falls within the server's 5-minute-to-30-day window", () => {
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      const now = new Date(at(2026, 9, 25, 0, 0).getTime() + hour * 3_600_000 + 59 * 60_000);
      for (const choice of SNOOZE_CHOICES) {
        const ahead = snoozeUntil(choice, now).getTime() - now.getTime();
        expect(ahead).toBeGreaterThanOrEqual(INBOX_SNOOZE_MIN_MS);
        expect(ahead).toBeLessThanOrEqual(INBOX_SNOOZE_MAX_MS);
      }
    }
  });
});
