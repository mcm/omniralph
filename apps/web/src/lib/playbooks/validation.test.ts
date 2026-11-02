import {
  BUILTIN_PLAYBOOKS,
  CUSTOM_PLAYBOOK_ROLES,
  getBuiltinPlaybook,
  SINK_KINDS,
} from "@omniralph/tasks";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { sinkOutputs, validatePlaybookAgainst } = await import("./validation");

const PLAYBOOK_ID = "0b6f7a0e-8a3d-4e43-9a51-2a8c55a1f6e2";

/** A clone of built-in `id` under the custom ID. */
function clone(id: string, overrides: Record<string, unknown> = {}) {
  return { ...getBuiltinPlaybook(id)!, id: PLAYBOOK_ID, name: "Mine", ...overrides };
}

describe("sinkOutputs", () => {
  it("says what every sink kind accepts", () => {
    const outputs = sinkOutputs();
    expect(Object.keys(outputs).sort()).toEqual([...SINK_KINDS].sort());
    expect(outputs["chat-thread"]).toEqual({ taskType: "query", output: "answer" });
    expect(outputs["run-result"]).toEqual({ taskType: "query", output: "any" });
    expect(outputs.review).toEqual({ taskType: "review" });
    expect(outputs["ralph-run"]).toEqual({ taskType: "coding" });
    expect(outputs["learned-rule"]).toMatchObject({
      taskType: "query",
      output: { schema: { type: "object", required: ["rule"] } },
    });
  });
});

describe("validatePlaybookAgainst", () => {
  it("accepts a clone of every built-in a custom playbook's role allows, with its requirements", () => {
    const clonable = BUILTIN_PLAYBOOKS.filter((p) => CUSTOM_PLAYBOOK_ROLES.includes(p.role));
    expect(clonable.length).toBeGreaterThan(5);
    for (const playbook of clonable) {
      const result = validatePlaybookAgainst(clone(playbook.id), BUILTIN_PLAYBOOKS);
      expect(result, playbook.id).toMatchObject({
        ok: true,
        playbook: { id: PLAYBOOK_ID, role: playbook.role },
        requirements: { minAgentVersion: expect.any(String) },
      });
    }
  });

  it("refuses a built-in-only role", () => {
    for (const id of ["builtin:triage", "builtin:learn-rule", "builtin:reply-to-finding"]) {
      expect(validatePlaybookAgainst(clone(id), BUILTIN_PLAYBOOKS)).toEqual({
        ok: false,
        fieldErrors: { role: expect.stringContaining("Only a built-in playbook") },
      });
    }
  });

  it("returns schema errors by field, refusing fields the role sets", () => {
    const result = validatePlaybookAgainst(
      clone("builtin:ask-about-code", { sink: "chat-thread" }),
      BUILTIN_PLAYBOOKS,
    );
    expect(result).toEqual({
      ok: false,
      fieldErrors: { sink: expect.stringContaining("role sets where its output goes") },
    });
    expect(
      validatePlaybookAgainst(clone("builtin:ask-about-code", { promptTemplate: "" }), []),
    ).toMatchObject({ ok: false, fieldErrors: { promptTemplate: expect.any(String) } });
  });

  it("refuses a model or token budget on a review playbook", () => {
    expect(
      validatePlaybookAgainst(clone("builtin:review-pr", { model: "opus" }), BUILTIN_PLAYBOOKS),
    ).toEqual({
      ok: false,
      fieldErrors: { model: expect.stringContaining("review depth sets it") },
    });
  });

  it("refuses a correlation playbook whose output isn't the correlation's", () => {
    const result = validatePlaybookAgainst(
      clone("builtin:correlate-findings", {
        outputSchema: { type: "object", properties: { text: { type: "string" } } },
      }),
      BUILTIN_PLAYBOOKS,
    );
    expect(result).toMatchObject({ ok: false, fieldErrors: { outputSchema: expect.any(String) } });
  });

  it("keys run spec errors by the playbook field: an unknown PR description playbook", () => {
    const missing = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";
    const result = validatePlaybookAgainst(
      clone("builtin:implement-story", { coding: { prDescriptionPlaybookId: missing } }),
      BUILTIN_PLAYBOOKS,
    );
    expect(result).toEqual({
      ok: false,
      fieldErrors: { "coding.prDescriptionPlaybookId": `There is no task ${missing}.` },
    });
  });

  it("accepts a story playbook naming the built-in verifier, and refuses one that isn't a verifier", () => {
    expect(
      validatePlaybookAgainst(
        clone("builtin:implement-story", {
          coding: { verifierPlaybookId: "builtin:verify-task" },
        }),
        BUILTIN_PLAYBOOKS,
      ),
    ).toMatchObject({ ok: true });
    const result = validatePlaybookAgainst(
      clone("builtin:implement-story", { coding: { verifierPlaybookId: "builtin:describe-pr" } }),
      BUILTIN_PLAYBOOKS,
    );
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: {
        "coding.verifierPlaybookId": "builtin:describe-pr isn't a verifier playbook.",
      },
    });
  });

  it("accepts a story playbook naming the built-in audit, and refuses one that isn't an audit", () => {
    expect(
      validatePlaybookAgainst(
        clone("builtin:implement-story", {
          coding: { auditPlaybookId: "builtin:audit-epic", maxAuditRounds: 3 },
        }),
        BUILTIN_PLAYBOOKS,
      ),
    ).toMatchObject({ ok: true });
    expect(
      validatePlaybookAgainst(
        clone("builtin:implement-story", { coding: { auditPlaybookId: "builtin:verify-task" } }),
        BUILTIN_PLAYBOOKS,
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { "coding.auditPlaybookId": "builtin:verify-task isn't an audit playbook." },
    });
  });

  it("accepts a review playbook whose loop names a verifier, and refuses one that isn't a verifier", () => {
    const review = (verifierPlaybookId: string) =>
      validatePlaybookAgainst(
        clone("builtin:review-pr", { loop: { verifierPlaybookId, maxIterations: 3 } }),
        BUILTIN_PLAYBOOKS,
      );
    expect(review("builtin:verify-task")).toMatchObject({ ok: true });
    expect(review("builtin:describe-pr")).toMatchObject({
      ok: false,
      fieldErrors: { "loop.verifierPlaybookId": "builtin:describe-pr isn't a verifier playbook." },
    });
    expect(review("builtin:missing")).toMatchObject({
      ok: false,
      fieldErrors: { "loop.verifierPlaybookId": "There is no playbook builtin:missing." },
    });
  });

  it("refuses a verifier on a request playbook", () => {
    expect(
      validatePlaybookAgainst(
        clone("builtin:handle-request", {
          coding: { verifierPlaybookId: "builtin:verify-task" },
        }),
        BUILTIN_PLAYBOOKS,
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { "coding.verifierPlaybookId": expect.stringContaining("Only story playbooks") },
    });
  });

  it("refuses a template variable the role's triggers don't provide", () => {
    const result = validatePlaybookAgainst(
      clone("builtin:ask-about-code", { promptTemplate: "{{nope}}" }),
      BUILTIN_PLAYBOOKS,
    );
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { promptTemplate: expect.stringContaining("{{nope}}") },
    });
  });
});
