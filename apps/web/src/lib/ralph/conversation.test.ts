import { describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { FakeTrackerGateway, NO_CAPABILITIES } from "@omniralph/tracker/testing";
import {
  ChatConversation,
  conversationFor,
  TrackerConversation,
  trackerConversation,
} from "./conversation";
import { postActivity } from "./notify";

vi.mock("server-only", () => ({}));

const linearRun = {
  id: "run-1",
  organizationId: "org-1",
  repositoryId: null,
  requestJobId: null,
  origin: "tracker" as const,
  trackerIssueId: "issue-1",
  trackerIdentifier: "ENG-1",
  trackerSessionId: "session-1",
  chatThreadId: null,
};

/** A chat run whose thread is gone (the chat side is covered in `conversation-chat.test.ts`). */
const chatRun = {
  id: "run-2",
  organizationId: "org-1",
  repositoryId: null,
  requestJobId: null,
  origin: "chat" as const,
  trackerIssueId: null,
  trackerIdentifier: null,
  trackerSessionId: null,
  chatThreadId: null,
};

describe("conversationFor", () => {
  it("writes a Linear run's activities, plan and links to its agent session", async () => {
    const tracker = new FakeLinearGateway();
    const conversation = conversationFor(linearRun, { tracker });
    expect(conversation).toBeInstanceOf(TrackerConversation);
    expect(conversation.name).toBe("tracker session session-1");

    await conversation.post({ type: "thought", body: "hi" }, { ephemeral: true });
    await conversation.updatePlan([{ content: "ENG-2", status: "pending" }]);
    await conversation.addLink("Pull request", "https://github.com/acme/app/pull/1");

    expect(tracker.activities).toEqual([
      {
        sessionId: "session-1",
        content: { type: "thought", body: "hi" },
        options: { ephemeral: true },
      },
    ]);
    expect(tracker.plans.get("session-1")).toEqual([[{ content: "ENG-2", status: "pending" }]]);
    expect(tracker.urls).toEqual([
      { sessionId: "session-1", label: "Pull request", url: "https://github.com/acme/app/pull/1" },
    ]);
  });

  it("gets a lazy gateway only when a Linear run writes", async () => {
    const tracker = new FakeLinearGateway();
    const source = vi.fn(async () => tracker);
    const conversation = conversationFor(linearRun, { tracker: source });
    expect(source).not.toHaveBeenCalled();
    await conversation.post({ type: "response", body: "done" });
    expect(source).toHaveBeenCalledOnce();
    expect(tracker.activities).toHaveLength(1);
  });

  it("gives a chat run its thread, never touching Linear", async () => {
    const source = vi.fn(async () => new FakeLinearGateway());
    const chat = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const conversation = conversationFor(chatRun, { tracker: source, chat });
    expect(conversation).toBeInstanceOf(ChatConversation);
    await conversation.post({ type: "response", body: "done" });
    await conversation.updatePlan([]);
    await conversation.addLink("Pull request", "https://github.com/acme/app/pull/1");
    expect(source).not.toHaveBeenCalled();
    // Its thread is gone: nothing to record (the plan records nothing anyway).
    expect(chat).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("conversationFor on a tracker without sessions", () => {
  const sessionless = () => {
    const tracker = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
    tracker.add({ id: "issue-1", identifier: "ENG-1", title: "Epic" });
    return tracker;
  };

  it("comments a run's activities on its work item, leaving ephemeral ones out", async () => {
    const tracker = sessionless();
    const conversation = conversationFor(linearRun, { tracker });

    await conversation.post({ type: "thought", body: "Working on it" }, { ephemeral: true });
    await conversation.post({ type: "thought", body: "Starting ENG-2" });
    await conversation.post({ type: "error", body: "CI failed" });
    await conversation.post(
      { type: "elicitation", body: "Which repo?" },
      { signal: "select", signalMetadata: { options: [{ value: "acme/app" }, { value: "" }] } },
    );

    expect(tracker.comments).toEqual([
      { issueId: "issue-1", body: "Starting ENG-2" },
      { issueId: "issue-1", body: "⚠️ CI failed" },
      { issueId: "issue-1", body: "Which repo?\n\nReply with one of:\n- `acme/app`" },
    ]);
  });

  it("comments the plan as a checklist, only when it changed", async () => {
    const tracker = sessionless();
    const conversation = conversationFor(linearRun, { tracker });
    const plan = [
      { content: "ENG-2 Add the API", status: "completed" as const },
      { content: "ENG-3 Add the UI", status: "inProgress" as const },
      { content: "ENG-4 Docs", status: "pending" as const },
      { content: "ENG-5 Old idea", status: "canceled" as const },
    ];

    await conversation.updatePlan(plan);
    await conversation.post({ type: "thought", body: "Still going" });
    await conversation.updatePlan(plan);
    await conversation.updatePlan([{ ...plan[0]! }, { ...plan[1]!, status: "completed" }]);

    expect(tracker.comments.map((c) => c.body)).toEqual([
      [
        "**Plan**",
        "",
        "- [x] ENG-2 Add the API",
        "- [ ] ⏳ ENG-3 Add the UI",
        "- [ ] ENG-4 Docs",
        "- [x] ~~ENG-5 Old idea~~",
      ].join("\n"),
      "Still going",
      ["**Plan**", "", "- [x] ENG-2 Add the API", "- [x] ENG-3 Add the UI"].join("\n"),
    ]);
  });

  it("links a run's PR/MR to its work item", async () => {
    const tracker = sessionless();
    await conversationFor(linearRun, { tracker }).addLink(
      "Pull request",
      "https://github.com/acme/app/pull/1",
    );
    expect(tracker.links).toEqual([
      { issueId: "issue-1", url: "https://github.com/acme/app/pull/1", title: "Pull request" },
    ]);
  });

  it("fails a write of a session with no work item to comment on", async () => {
    const conversation = trackerConversation(sessionless(), "session-1");
    await expect(conversation.post({ type: "response", body: "done" })).rejects.toThrow(
      "has no work item to comment on",
    );
  });
});

describe("postActivity", () => {
  it("logs a failed post instead of throwing", async () => {
    const tracker = new FakeLinearGateway();
    vi.spyOn(tracker.sessions, "createActivity").mockRejectedValue(new Error("Linear is down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const posted = await postActivity(conversationFor(linearRun, { tracker }), {
      type: "error",
      body: "oops",
    });
    expect(posted).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Posting an activity (error) to tracker session session-1 failed: Linear is down",
    );
    warn.mockRestore();
  });
});
