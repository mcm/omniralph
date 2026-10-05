import { describe, expect, it } from "vitest";
import { parseGitHubCommentEvent, parseGitLabCommentEvent } from "./events";

const user = { login: "octocat", type: "User" };

describe("parseGitHubCommentEvent", () => {
  it("parses a PR conversation comment (issue_comment)", () => {
    const body = {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://api.github.com/…" } },
      comment: { id: 11, body: "@omniralph review", user },
    };
    expect(parseGitHubCommentEvent("issue_comment", body)).toEqual({
      number: 7,
      commentId: "11",
      body: "@omniralph review",
      author: { username: "octocat", isBot: false },
      threadIds: [],
      replyTo: { kind: "conversation" },
    });
  });

  it("ignores issue comments on issues, and edits", () => {
    const comment = { id: 11, body: "@omniralph review", user };
    expect(
      parseGitHubCommentEvent("issue_comment", {
        action: "created",
        issue: { number: 7 },
        comment,
      }),
    ).toBeNull();
    expect(
      parseGitHubCommentEvent("issue_comment", {
        action: "edited",
        issue: { number: 7, pull_request: {} },
        comment,
      }),
    ).toBeNull();
  });

  it("parses a reply in an inline thread, keyed by the thread's first comment", () => {
    const body = {
      action: "created",
      pull_request: { number: 7 },
      comment: { id: 22, in_reply_to_id: 20, body: "@omniralph dismiss", user },
    };
    expect(parseGitHubCommentEvent("pull_request_review_comment", body)).toMatchObject({
      number: 7,
      commentId: "22",
      threadIds: ["20"],
      replyTo: { kind: "thread", commentId: "20" },
    });
    const root = { ...body, comment: { ...body.comment, in_reply_to_id: null } };
    expect(parseGitHubCommentEvent("pull_request_review_comment", root)).toMatchObject({
      threadIds: ["22"],
      replyTo: { kind: "thread", commentId: "22" },
    });
  });

  it("flags bot authors and ignores other events", () => {
    const body = {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { id: 11, body: "x", user: { login: "omniralph[bot]", type: "Bot" } },
    };
    expect(parseGitHubCommentEvent("issue_comment", body)?.author).toEqual({
      username: "omniralph[bot]",
      isBot: true,
    });
    expect(parseGitHubCommentEvent("pull_request", body)).toBeNull();
    expect(parseGitHubCommentEvent("issue_comment", { action: "created" })).toBeNull();
  });
});

describe("parseGitLabCommentEvent", () => {
  const note = (attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    object_kind: "note",
    user: { username: "dev" },
    project: { id: 200 },
    merge_request: { iid: 9 },
    object_attributes: {
      id: 501,
      note: "@omniralph why?",
      noteable_type: "MergeRequest",
      action: "create",
      type: "DiffNote",
      discussion_id: "d".repeat(40),
      ...attrs,
    },
    ...extra,
  });

  it("parses a note in a diff discussion", () => {
    expect(parseGitLabCommentEvent("Note Hook", note())).toEqual({
      number: 9,
      commentId: "501",
      body: "@omniralph why?",
      author: { username: "dev", isBot: false },
      threadIds: ["d".repeat(40), "501"],
      replyTo: { kind: "thread", commentId: "d".repeat(40) },
    });
  });

  it("replies to top-level notes in the MR conversation", () => {
    expect(parseGitLabCommentEvent("Note Hook", note({ type: null }))).toMatchObject({
      replyTo: { kind: "conversation" },
    });
  });

  it("ignores system notes, edits, other noteables and other events", () => {
    expect(parseGitLabCommentEvent("Note Hook", note({ system: true }))).toBeNull();
    expect(parseGitLabCommentEvent("Note Hook", note({ action: "update" }))).toBeNull();
    expect(parseGitLabCommentEvent("Note Hook", note({ noteable_type: "Issue" }))).toBeNull();
    expect(parseGitLabCommentEvent("Note Hook", note({}, { merge_request: undefined }))).toBeNull();
    expect(parseGitLabCommentEvent("Merge Request Hook", note())).toBeNull();
    // Older GitLab versions send no action.
    expect(parseGitLabCommentEvent("Note Hook", note({ action: undefined }))).not.toBeNull();
  });
});
