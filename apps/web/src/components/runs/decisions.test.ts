import { describe, expect, it } from "vitest";
import {
  INBOX_ACTIONS,
  INBOX_SNOOZE_MAX_MS,
  INBOX_SNOOZE_MIN_MS,
  type InboxItem,
} from "@/lib/api/inbox";
import { inboxDecisions, SNOOZE_CHOICES, snoozeUntil } from "./decisions";

const ALL = [...INBOX_ACTIONS];
const buttons = (kind: InboxItem["kind"], actions: InboxItem["actions"] = ALL) =>
  inboxDecisions({ kind, actions }).map(({ label, action, variant }) => [label, action, variant]);

describe("inboxDecisions", () => {
  it("a manual story: Done, resume epic · Skip story · Snooze", () => {
    expect(buttons("manual_story")).toEqual([
      ["Done, resume epic", "done", "primary"],
      ["Skip story", "skip", "outline"],
      ["Snooze", "snooze", "outline"],
    ]);
  });

  it("a blocked epic: Start anyway · Done · Snooze", () => {
    expect(buttons("blocked_epic")).toEqual([
      ["Start anyway", "start_anyway", "primary"],
      ["Done", "done", "outline"],
      ["Snooze", "snooze", "outline"],
    ]);
  });

  it("a question: Send answer · Done · Snooze", () => {
    expect(buttons("question")).toEqual([
      ["Send answer", "answer", "primary"],
      ["Done", "done", "outline"],
      ["Snooze", "snooze", "outline"],
    ]);
  });

  it("a stopped epic: Resume · Done · Snooze", () => {
    expect(buttons("stopped_epic")).toEqual([
      ["Resume", "resume", "primary"],
      ["Done", "done", "outline"],
      ["Snooze", "snooze", "outline"],
    ]);
  });

  it.each(["prd_ready", "pr_waiting", "agent_offline", "agent_update_failed"] as const)(
    "%s: Done · Snooze",
    (kind) => {
      expect(buttons(kind)).toEqual([
        ["Done", "done", "primary"],
        ["Snooze", "snooze", "outline"],
      ]);
    },
  );

  it.each(["failed_run", "failed_system"] as const)("%s: Retry · Done · Snooze", (kind) => {
    expect(buttons(kind)).toEqual([
      ["Retry", "retry", "primary"],
      ["Done", "done", "outline"],
      ["Snooze", "snooze", "outline"],
    ]);
  });

  it("a running run: none", () => {
    expect(buttons("run")).toEqual([]);
  });

  it("shows a button only when the item's actions include its action", () => {
    expect(buttons("manual_story", ["skip", "snooze"])).toEqual([
      ["Skip story", "skip", "primary"],
      ["Snooze", "snooze", "outline"],
    ]);
    expect(buttons("failed_run", ["done"])).toEqual([["Done", "done", "primary"]]);
    expect(buttons("stopped_epic", [])).toEqual([]);
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
