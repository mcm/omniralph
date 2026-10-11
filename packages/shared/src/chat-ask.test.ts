import { describe, expect, it } from "vitest";
import { CHAT_ASK_JOB_TYPE, ChatAskFileReference } from "./chat-ask.js";

describe("chat.ask", () => {
  it("has the chat.ask job type", () => {
    expect(CHAT_ASK_JOB_TYPE).toBe("chat.ask");
  });

  it("validates file references", () => {
    expect(ChatAskFileReference.safeParse({ path: "a.ts", startLine: 2 }).success).toBe(true);
    expect(ChatAskFileReference.safeParse({ path: "a.ts", startLine: 2, endLine: 4 }).success).toBe(
      true,
    );
    expect(ChatAskFileReference.safeParse({ path: "a", endLine: 3 }).success).toBe(false);
    expect(ChatAskFileReference.safeParse({ path: "a", startLine: 5, endLine: 3 }).success).toBe(
      false,
    );
  });
});
