import { describe, expect, it } from "vitest";
import { classifyWebhook, signBody, TRIAGE_LABEL, verifyWebhook } from "./webhook";

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

  it("classifies an update that adds the coding:triage label, ignoring case", () => {
    const update = (labels: Array<{ id: string; name: string }>, before: string[]) => ({
      type: "Issue",
      action: "update",
      updatedFrom: { labelIds: before },
      data: { id: "i3", identifier: "TOOL-3", labelIds: labels.map((l) => l.id), labels },
    });
    for (const name of [TRIAGE_LABEL, "Coding:Triage"]) {
      expect(classifyWebhook(update([{ id: "l1", name }], []))).toEqual({
        kind: "triage_label_added",
        issueId: "i3",
        identifier: "TOOL-3",
        labelId: "l1",
      });
    }
    expect(classifyWebhook(update([{ id: "l1", name: "coding:triaged" }], []))).toMatchObject({
      kind: "ignored",
    });
  });

  it("still classifies an update that adds the ralph:triage label, ignoring case", () => {
    const update = (labels: Array<{ id: string; name: string }>, before: string[]) => ({
      type: "Issue",
      action: "update",
      updatedFrom: { labelIds: before },
      data: { id: "i3", identifier: "TOOL-3", labelIds: labels.map((l) => l.id), labels },
    });
    expect(classifyWebhook(update([{ id: "l1", name: "ralph:triage" }], []))).toEqual({
      kind: "triage_label_added",
      issueId: "i3",
      identifier: "TOOL-3",
      labelId: "l1",
    });
    expect(
      classifyWebhook(
        update(
          [
            { id: "l2", name: "bug" },
            { id: "l1", name: "Ralph:Triage" },
          ],
          ["l2"],
        ),
      ),
    ).toMatchObject({ kind: "triage_label_added", labelId: "l1" });
  });

  it("classifies a state change that also adds ralph:triage as both", () => {
    const update = (labels: Array<{ id: string; name: string }>, before: string[]) => ({
      type: "Issue",
      action: "update",
      updatedFrom: { stateId: "old", labelIds: before },
      data: {
        id: "i4",
        identifier: "TOOL-4",
        state: { type: "backlog" },
        labelIds: labels.map((l) => l.id),
        labels,
      },
    });
    expect(classifyWebhook(update([{ id: "l1", name: "Ralph:Triage" }], []))).toEqual({
      kind: "issue_state",
      issueId: "i4",
      identifier: "TOOL-4",
      stateType: "backlog",
      removed: false,
      triageLabelId: "l1",
    });
    // The label was already there, or another label was added: just the state change.
    for (const payload of [
      update([{ id: "l1", name: "ralph:triage" }], ["l1"]),
      update([{ id: "l2", name: "bug" }], []),
    ]) {
      const event = classifyWebhook(payload);
      expect(event).toMatchObject({ kind: "issue_state", issueId: "i4" });
      expect(event).not.toHaveProperty("triageLabelId");
    }
  });

  it("ignores other label changes", () => {
    const update = (
      labels: Array<{ id: string; name: string }>,
      before: string[],
      extra: Record<string, unknown> = {},
    ) => ({
      type: "Issue",
      action: "update",
      updatedFrom: { labelIds: before },
      data: { id: "i3", labelIds: labels.map((l) => l.id), labels, ...extra },
    });
    const triage = { id: "l1", name: "ralph:triage" };
    const bug = { id: "l2", name: "bug" };
    for (const payload of [
      // Another label added next to an existing ralph:triage.
      update([triage, bug], ["l1"]),
      // ralph:triage removed.
      update([bug], ["l1", "l2"]),
      // A label with a similar name.
      update([{ id: "l3", name: "ralph:triaged" }], []),
      // Label names missing from the payload.
      {
        type: "Issue",
        action: "update",
        updatedFrom: { labelIds: [] },
        data: { id: "i3", labelIds: ["l1"] },
      },
      // Labels unchanged.
      {
        type: "Issue",
        action: "update",
        updatedFrom: { title: "x" },
        data: { id: "i3", labelIds: ["l1"], labels: [triage] },
      },
      // A new issue created with the label.
      { type: "Issue", action: "create", data: { id: "i3", labelIds: ["l1"], labels: [triage] } },
    ]) {
      expect(classifyWebhook(payload).kind).toBe("ignored");
    }
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
