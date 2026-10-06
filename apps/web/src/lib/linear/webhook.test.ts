import { describe, expect, it } from "vitest";
import { classifyWebhook, signBody, verifyWebhook } from "./webhook";

const SECRET = "linear-secret";
const NOW = 1_790_000_000_000;

describe("verifyWebhook", () => {
  const body = JSON.stringify({ type: "Issue", webhookTimestamp: NOW });

  it("accepts a correctly signed, fresh delivery", () => {
    expect(verifyWebhook(body, signBody(body, SECRET), SECRET, NOW)).toEqual({
      ok: true,
      payload: { type: "Issue", webhookTimestamp: NOW },
    });
  });

  it("rejects missing and wrong signatures", () => {
    expect(verifyWebhook(body, null, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing_signature",
    });
    expect(verifyWebhook(body, signBody(body, "other"), SECRET, NOW)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    expect(verifyWebhook(body, "zz", SECRET, NOW)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    expect(verifyWebhook(`${body} `, signBody(body, SECRET), SECRET, NOW)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects timestamps skewed by more than 60s either way, or missing", () => {
    for (const [ts, ok] of [
      [NOW - 60_000, true],
      [NOW + 60_000, true],
      [NOW - 60_001, false],
      [NOW + 60_001, false],
      [undefined, false],
    ] as const) {
      const b = JSON.stringify({ type: "Issue", webhookTimestamp: ts });
      expect(verifyWebhook(b, signBody(b, SECRET), SECRET, NOW).ok).toBe(ok);
    }
  });

  it("rejects signed non-object JSON", () => {
    for (const b of ["not json", "[]", "null"]) {
      expect(verifyWebhook(b, signBody(b, SECRET), SECRET, NOW)).toEqual({
        ok: false,
        reason: "invalid_json",
      });
    }
  });
});

describe("classifyWebhook", () => {
  it("classifies a created agent session", () => {
    expect(
      classifyWebhook({
        type: "AgentSessionEvent",
        action: "created",
        promptContext: "<issue>…</issue>",
        agentSession: {
          id: "s1",
          issue: { id: "i1", identifier: "TOOL-1" },
          comment: { body: "@omniralph go" },
          creator: { name: "Steve" },
        },
      }),
    ).toEqual({
      kind: "session_created",
      sessionId: "s1",
      issueId: "i1",
      issueIdentifier: "TOOL-1",
      promptContext: "<issue>…</issue>",
      commentBody: "@omniralph go",
      creatorName: "Steve",
    });
  });

  it("classifies a prompt, including the stop signal", () => {
    expect(
      classifyWebhook({
        type: "AgentSessionEvent",
        action: "prompted",
        agentSession: { id: "s1", issueId: "i1" },
        agentActivity: { content: { body: "stop" }, signal: "stop", user: { name: "Bo" } },
      }),
    ).toEqual({
      kind: "session_prompted",
      sessionId: "s1",
      issueId: "i1",
      body: "stop",
      signal: "stop",
      authorName: "Bo",
    });
  });

  it("classifies issue state changes and removals", () => {
    expect(
      classifyWebhook({
        type: "Issue",
        action: "update",
        updatedFrom: { stateId: "old" },
        data: { id: "i2", identifier: "TOOL-2", state: { type: "completed" } },
      }),
    ).toEqual({
      kind: "issue_state",
      issueId: "i2",
      identifier: "TOOL-2",
      stateType: "completed",
      removed: false,
    });
    expect(classifyWebhook({ type: "Issue", action: "remove", data: { id: "i2" } })).toMatchObject({
      kind: "issue_state",
      removed: true,
    });
  });

  it("ignores everything else", () => {
    const ignored = [
      { type: "Comment", action: "create" },
      { type: "Issue", action: "update", updatedFrom: { title: "x" }, data: { id: "i" } },
      { type: "Issue", action: "create", data: { id: "i" } },
      { type: "Issue", action: "remove", data: {} },
      { type: "AgentSessionEvent", action: "created", agentSession: {} },
      { type: "AgentSessionEvent", action: "created", agentSession: { id: "s1" } },
      { type: "AgentSessionEvent", action: "updated", agentSession: { id: "s1", issueId: "i" } },
    ];
    for (const payload of ignored) expect(classifyWebhook(payload).kind).toBe("ignored");
  });
});
