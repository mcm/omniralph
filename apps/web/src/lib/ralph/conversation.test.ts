import { describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { ChatConversation, conversationFor, LinearConversation } from "./conversation";
import { postActivity } from "./notify";

vi.mock("server-only", () => ({}));

const linearRun = {
  id: "run-1",
  organizationId: "org-1",
  repositoryId: null,
  requestJobId: null,
  origin: "linear" as const,
  linearIssueId: "issue-1",
  linearIdentifier: "ENG-1",
  linearAgentSessionId: "session-1",
  chatThreadId: null,
};

/** A chat run whose thread is gone (the chat side is covered in `conversation-chat.test.ts`). */
const chatRun = {
  id: "run-2",
  organizationId: "org-1",
  repositoryId: null,
  requestJobId: null,
  origin: "chat" as const,
  linearIssueId: null,
  linearIdentifier: null,
  linearAgentSessionId: null,
  chatThreadId: null,
};

describe("conversationFor", () => {
  it("writes a Linear run's activities, plan and links to its agent session", async () => {
    const linear = new FakeLinearGateway();
    const conversation = conversationFor(linearRun, { linear });
    expect(conversation).toBeInstanceOf(LinearConversation);
    expect(conversation.name).toBe("Linear session session-1");

    await conversation.post({ type: "thought", body: "hi" }, { ephemeral: true });
    await conversation.updatePlan([{ content: "ENG-2", status: "pending" }]);
    await conversation.addLink("Pull request", "https://github.com/acme/app/pull/1");

    expect(linear.activities).toEqual([
      {
        sessionId: "session-1",
        content: { type: "thought", body: "hi" },
        options: { ephemeral: true },
      },
    ]);
    expect(linear.plans.get("session-1")).toEqual([[{ content: "ENG-2", status: "pending" }]]);
    expect(linear.urls).toEqual([
      { sessionId: "session-1", label: "Pull request", url: "https://github.com/acme/app/pull/1" },
    ]);
  });

  it("gets a lazy gateway only when a Linear run writes", async () => {
    const linear = new FakeLinearGateway();
    const source = vi.fn(async () => linear);
    const conversation = conversationFor(linearRun, { linear: source });
    expect(source).not.toHaveBeenCalled();
    await conversation.post({ type: "response", body: "done" });
    expect(source).toHaveBeenCalledOnce();
    expect(linear.activities).toHaveLength(1);
  });

  it("gives a chat run its thread, never touching Linear", async () => {
    const source = vi.fn(async () => new FakeLinearGateway());
    const chat = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const conversation = conversationFor(chatRun, { linear: source, chat });
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

describe("postActivity", () => {
  it("logs a failed post instead of throwing", async () => {
    const linear = new FakeLinearGateway();
    vi.spyOn(linear.sessions, "createActivity").mockRejectedValue(new Error("Linear is down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const posted = await postActivity(conversationFor(linearRun, { linear }), {
      type: "error",
      body: "oops",
    });
    expect(posted).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Posting an activity (error) to Linear session session-1 failed: Linear is down",
    );
    warn.mockRestore();
  });
});
