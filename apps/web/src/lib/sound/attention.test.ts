import { describe, expect, it } from "vitest";
import { createAttentionGate, inboxCountsCue, runOutcomeCue } from "./attention";

const counts = (needsYou: number, problems: number, questions = 0) => ({
  needsYou,
  problems,
  questions,
});

describe("inboxCountsCue", () => {
  it("plays nothing for the first counts (a page load)", () => {
    expect(inboxCountsCue(undefined, counts(3, 2, 1))).toBeNull();
  });

  it("names a new question, else something new needing you, else a new problem", () => {
    expect(inboxCountsCue(counts(1, 0, 0), counts(2, 0, 1))).toBe("mention");
    expect(inboxCountsCue(counts(1, 0), counts(2, 0))).toBe("notification");
    expect(inboxCountsCue(counts(1, 0), counts(1, 1))).toBe("warning");
    // Both at once: the needs-you cue.
    expect(inboxCountsCue(counts(1, 0), counts(2, 1))).toBe("notification");
  });

  it("plays nothing when items only go away", () => {
    expect(inboxCountsCue(counts(2, 2, 1), counts(1, 1, 0))).toBeNull();
    expect(inboxCountsCue(counts(2, 2), counts(2, 2))).toBeNull();
  });
});

describe("runOutcomeCue", () => {
  it("plays complete or error when a live run finishes or fails", () => {
    expect(runOutcomeCue("running", "completed")).toBe("complete");
    expect(runOutcomeCue("queued", "failed")).toBe("error");
    expect(runOutcomeCue("waiting", "completed")).toBe("complete");
  });

  it("plays nothing on the first load, for a stop, or for a run that wasn't live", () => {
    expect(runOutcomeCue(undefined, "completed")).toBeNull();
    expect(runOutcomeCue("running", "stopped")).toBeNull();
    expect(runOutcomeCue("failed", "completed")).toBeNull();
    expect(runOutcomeCue("running", "waiting")).toBeNull();
  });
});

describe("createAttentionGate", () => {
  it("lets one cue through per gap, so a burst plays once", () => {
    let now = 0;
    const gate = createAttentionGate(4_000, () => now);
    expect(gate()).toBe(true);
    now = 1_000;
    expect(gate()).toBe(false);
    now = 4_000;
    expect(gate()).toBe(true);
  });
});
