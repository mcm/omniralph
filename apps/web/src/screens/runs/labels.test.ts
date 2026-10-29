import { describe, expect, it } from "vitest";
import { RUN_KINDS, RUN_STATUSES } from "@/lib/api/runs";
import { runRowLabel } from "./labels";

const KIND = { epic: "Epic", request: "Request", review: "Review", triage: "Triage", ask: "Ask" };
const STATE = {
  queued: "queued",
  running: "running",
  waiting: "waiting on you",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
  skipped: "skipped",
};
const TONE = {
  queued: "run",
  running: "run",
  waiting: "need",
  completed: "neutral",
  failed: "fail",
  stopped: "need",
  skipped: "neutral",
};

describe("runRowLabel", () => {
  for (const kind of RUN_KINDS) {
    for (const status of RUN_STATUSES) {
      it(`labels a ${status} ${kind} "${KIND[kind]} · ${STATE[status]}"`, () => {
        expect(runRowLabel({ kind, status })).toEqual({
          label: `${KIND[kind]} · ${STATE[status]}`,
          tone: TONE[status],
        });
      });
    }
  }

  it("labels a running epic Epic · running while a story runs, as the Inbox's Running tab does", () => {
    // Which story runs is on the run's status line, never in the row (Design rule 8).
    expect(runRowLabel({ kind: "epic", status: "running" })).toEqual({
      label: "Epic · running",
      tone: "run",
    });
  });
});
