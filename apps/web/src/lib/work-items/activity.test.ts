import { describe, expect, it } from "vitest";
import {
  commentExcerpt,
  eventSentence,
  shortName,
  triageEntries,
  workItemActivity,
} from "./activity";

const at = (iso: string) => new Date(iso);
const event = (kind: Parameters<typeof eventSentence>[0]["kind"], detail = {}) => ({
  kind,
  actorName: "Steve McMaster",
  detail,
});

describe("work item activity", () => {
  it("says what each event did, by the actor's first name", () => {
    expect(eventSentence(event("created"))).toBe("Steve created it");
    expect(eventSentence(event("created", { origin: "ask" }))).toBe("Steve created it from Ask");
    expect(eventSentence(event("repo_changed", { repository: "acme/customer-portal" }))).toBe(
      "Steve changed the repo to customer-portal",
    );
    expect(eventSentence(event("repo_reset"))).toBe(
      "Steve went back to the routing rules for the repo",
    );
    expect(eventSentence(event("moved_to_needs_refining"))).toBe(
      "Steve moved it to Needs refining",
    );
    expect(eventSentence(event("prd_edited"))).toBe("Steve edited the PRD");
    expect(eventSentence(event("triage_requested"))).toBe("Steve asked Om to triage it");
    expect(eventSentence(event("started"))).toBe("Steve started it");
    expect(eventSentence(event("share_link_created"))).toBe("Steve created a review link");
    expect(eventSentence(event("share_link_revoked"))).toBe("Steve revoked a review link");
    expect(eventSentence(event("canceled"))).toBe("Steve removed it from the backlog");
    expect(shortName("  ")).toBe("Someone");
  });

  it("says what triage did: its size, its open questions, or that it failed", () => {
    const run = {
      id: "t1",
      createdAt: at("2026-10-01T00:00:00.000Z"),
      updatedAt: at("2026-10-01T01:00:00.000Z"),
    };
    const texts = (r: Parameters<typeof triageEntries>[0]) => triageEntries(r).map((e) => e.text);
    expect(
      texts({
        ...run,
        status: "completed",
        lastResult: { outcome: { size: "M", openQuestions: ["Which DB?"] } },
      }),
    ).toEqual(["Om left 1 open question", "Om triaged it (size M)"]);
    expect(
      texts({ ...run, status: "completed", lastResult: { outcome: { openQuestions: [] } } }),
    ).toEqual(["Om triaged it"]);
    expect(texts({ ...run, status: "running", lastResult: null })).toEqual([
      "Om started triaging it",
    ]);
    expect(texts({ ...run, status: "failed", lastResult: null })).toEqual([
      "Om couldn't triage it",
    ]);
    expect(texts({ ...run, status: "stopped", lastResult: null })).toEqual([
      "Om's triage was stopped",
    ]);
  });

  it("quotes a comment's first line, shortened", () => {
    expect(commentExcerpt("\n  First line  \nsecond")).toBe("First line");
    expect(commentExcerpt("x".repeat(200))).toHaveLength(140);
  });

  it("merges events, triage runs and comments newest first", () => {
    const activity = workItemActivity({
      events: [
        {
          id: "e1",
          kind: "moved_to_needs_refining",
          actorName: "Steve McMaster",
          detail: {},
          createdAt: at("2026-10-03T00:00:00.000Z"),
        },
      ],
      triageRuns: [
        {
          id: "t1",
          status: "completed",
          lastResult: { outcome: { size: "S", openQuestions: [] } },
          createdAt: at("2026-10-01T00:00:00.000Z"),
          updatedAt: at("2026-10-01T00:10:00.000Z"),
        },
      ],
      comments: [
        { author: "Anna", body: "Ship it", createdAt: "2026-10-02T00:00:00.000Z" },
        { author: null, body: "No date", createdAt: "" },
      ],
    });
    expect(activity).toEqual([
      {
        id: "event-e1",
        source: "event",
        text: "Steve moved it to Needs refining",
        at: "2026-10-03T00:00:00.000Z",
      },
      {
        id: "comment-0",
        source: "comment",
        text: "Anna commented: Ship it",
        at: "2026-10-02T00:00:00.000Z",
      },
      {
        id: "triage-t1-triaged",
        source: "triage",
        text: "Om triaged it (size S)",
        at: "2026-10-01T00:10:00.000Z",
      },
    ]);
  });
});
