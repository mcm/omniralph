import { describe, expect, it } from "vitest";
import {
  CHAT_ASK_JOB_TYPE,
  ChatAskJobPayload,
  ChatAskJobResult,
  chatAskTokenCap,
  MAX_CHAT_ASK_ANSWER_LENGTH,
  MAX_CHAT_ASK_REFERENCES,
} from "./chat-ask.js";

const payload = {
  repositoryId: "00000000-0000-4000-8000-000000000001",
  repository: {
    provider: "github",
    fullPath: "acme/app",
    cloneUrl: "https://github.com/acme/app.git",
  },
  defaultBranch: "main",
  question: "Where are webhooks verified?",
  context: null,
  chatThreadId: "00000000-0000-4000-8000-000000000002",
  model: null,
  maxTokens: 10_000,
};

const result = {
  answer: "In `src/webhooks.ts:12`.",
  outcome: "answered",
  references: [{ path: "src/webhooks.ts", startLine: 12 }],
  usage: { inputTokens: 1000, outputTokens: 30 },
  durationMs: 10,
};

describe("chat.ask", () => {
  it("has the chat.ask job type", () => {
    expect(CHAT_ASK_JOB_TYPE).toBe("chat.ask");
  });

  it("parses a payload and rejects one without a thread or with a bad branch", () => {
    expect(ChatAskJobPayload.safeParse(payload).success).toBe(true);
    expect(ChatAskJobPayload.safeParse({ ...payload, context: "earlier: …" }).success).toBe(true);
    expect(ChatAskJobPayload.safeParse({ ...payload, chatThreadId: "x" }).success).toBe(false);
    expect(ChatAskJobPayload.safeParse({ ...payload, defaultBranch: "../x" }).success).toBe(false);
    expect(ChatAskJobPayload.safeParse({ ...payload, question: "" }).success).toBe(false);
  });

  it("accepts an answer with optional references, or none when it didn't finish", () => {
    expect(ChatAskJobResult.safeParse(result).success).toBe(true);
    const { references: _, ...withoutReferences } = result;
    expect(ChatAskJobResult.safeParse(withoutReferences).success).toBe(true);
    for (const outcome of ["budget_exhausted", "no_checkout"]) {
      expect(ChatAskJobResult.safeParse({ ...result, outcome, answer: null }).success).toBe(true);
    }
  });

  it("rejects mismatched outcomes, too-long answers and bad references", () => {
    expect(ChatAskJobResult.safeParse({ ...result, answer: null }).success).toBe(false);
    expect(
      ChatAskJobResult.safeParse({ ...result, answer: "x".repeat(MAX_CHAT_ASK_ANSWER_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(
      ChatAskJobResult.safeParse({ ...result, references: [{ path: "a", endLine: 3 }] }).success,
    ).toBe(false);
    expect(
      ChatAskJobResult.safeParse({
        ...result,
        references: [{ path: "a", startLine: 5, endLine: 3 }],
      }).success,
    ).toBe(false);
    expect(
      ChatAskJobResult.safeParse({
        ...result,
        references: Array.from({ length: MAX_CHAT_ASK_REFERENCES + 1 }, () => ({ path: "a" })),
      }).success,
    ).toBe(false);
  });

  it("caps a question at a quarter of the review budget", () => {
    expect(chatAskTokenCap(200_000)).toBe(50_000);
    expect(chatAskTokenCap(1)).toBe(1);
  });
});
