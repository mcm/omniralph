import { describe, expect, it } from "vitest";
import { CAPABILITIES, isCapability } from "./index.js";
import { CAPABILITY_JOB_SCOPES, defaultCapabilityLimit } from "./protocol.js";
import {
  TRIAGE_CAPABILITY,
  TRIAGE_JOB_TYPES,
  TRIAGE_RUN_JOB_TYPE,
  TriageRunPayload,
  TriageRunResult,
} from "./triage-job.js";

const issue = {
  id: "30ed0e14-6d6a-4dba-8962-4c010fca69af",
  identifier: "TOOL-152",
  title: "Triage capability",
  description: "Let ralph triage issues.",
  stateType: "backlog",
  creator: { id: "user-1", name: "Ana" },
};

const payload = {
  triageRunId: "00000000-0000-4000-8000-000000000001",
  issue,
  comments: [
    { author: "Ana", body: "Use the linear-prd skill.", createdAt: "2026-10-10T00:00:00Z" },
  ],
  children: [
    {
      id: "child-1",
      identifier: "TOOL-153",
      title: "Add the capability",
      description: "As an admin…",
      stateType: "unstarted",
      priority: 2,
    },
  ],
  blockers: [
    { identifier: "TOOL-100", title: "Agent sessions", stateType: "started", blocks: "TOOL-152" },
  ],
  repository: {
    repositoryId: "00000000-0000-4000-8000-000000000002",
    repository: {
      provider: "github",
      fullPath: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
    },
    defaultBranch: "main",
  },
};

const outcome = {
  size: "L",
  title: "Triage capability: unattended PRD triage",
  description: "## Introduction\n\n…",
  openQuestions: ["Which label triggers triage?"],
};

const result = {
  summary: "Sized L; 3 stories; 1 open question.",
  outcome,
  usage: { inputTokens: 1000, outputTokens: 200 },
  durationMs: 30_000,
};

describe("triage capability", () => {
  it("is a read-only capability with one job type", () => {
    expect(CAPABILITIES).toContain(TRIAGE_CAPABILITY);
    expect(isCapability("triage")).toBe(true);
    expect(CAPABILITY_JOB_SCOPES.triage).toEqual(["credentials:read"]);
    expect(CAPABILITY_JOB_SCOPES.triage).not.toContain("credentials:write");
    expect(TRIAGE_RUN_JOB_TYPE).toBe("triage.run");
    expect(TRIAGE_JOB_TYPES).toEqual(["triage.run"]);
  });

  it("gets the same default concurrency limit as review", () => {
    for (const slots of [1, 2, 4]) {
      expect(defaultCapabilityLimit("triage", slots)).toBe(defaultCapabilityLimit("review", slots));
    }
  });
});

describe("TriageRunPayload", () => {
  it("parses a full payload", () => {
    const parsed = TriageRunPayload.parse({
      ...payload,
      reply: "1: the ralph:triage label",
      previousResult: outcome,
    });
    expect(parsed.issue.creator).toEqual({ id: "user-1", name: "Ana" });
    expect(parsed.children[0]!.priority).toBe(2);
    expect(parsed.blockers[0]!.blocks).toBe("TOOL-152");
    expect(parsed.repository?.defaultBranch).toBe("main");
    expect(parsed.reply).toBe("1: the ralph:triage label");
    expect(parsed.previousResult?.childUpdates).toEqual([]);
  });

  it("defaults the optional parts", () => {
    const parsed = TriageRunPayload.parse({
      triageRunId: payload.triageRunId,
      issue: { ...issue, creator: null },
    });
    expect(parsed).toMatchObject({
      comments: [],
      children: [],
      blockers: [],
      repository: null,
      reply: null,
      previousResult: null,
    });
  });

  it("rejects invalid payloads", () => {
    const invalid = [
      { ...payload, triageRunId: "run-1" },
      { ...payload, issue: { ...issue, stateType: "doing" } },
      { ...payload, issue: { ...issue, identifier: "" } },
      { ...payload, children: [{ ...payload.children[0], priority: 5 }] },
      { ...payload, repository: { ...payload.repository, defaultBranch: "../main" } },
      { ...payload, repository: { ...payload.repository, repository: { provider: "svn" } } },
      { ...payload, previousResult: { ...outcome, size: "XXL" } },
    ];
    for (const value of invalid) {
      expect(TriageRunPayload.safeParse(value).success).toBe(false);
    }
  });
});

describe("TriageRunResult", () => {
  it("parses an outcome", () => {
    const parsed = TriageRunResult.parse({
      ...result,
      outcome: {
        ...outcome,
        childUpdates: [{ id: "child-1", title: "Add the capability", description: "As an admin…" }],
      },
    });
    expect(parsed.error).toBeNull();
    expect(parsed.outcome?.size).toBe("L");
    expect(parsed.outcome?.childUpdates).toHaveLength(1);
  });

  it("parses a failure", () => {
    const parsed = TriageRunResult.parse({ ...result, outcome: null, error: "session failed" });
    expect(parsed.outcome).toBeNull();
  });

  it("rejects invalid results", () => {
    const invalid = [
      { ...result, outcome: null },
      { ...result, error: "session failed" },
      { ...result, outcome: { ...outcome, size: "XXL" } },
      { ...result, outcome: { ...outcome, title: "  " } },
      { ...result, outcome: { ...outcome, openQuestions: [""] } },
      { ...result, usage: { inputTokens: -1, outputTokens: 0 } },
      { ...result, durationMs: 1.5 },
    ];
    for (const value of invalid) {
      expect(TriageRunResult.safeParse(value).success).toBe(false);
    }
  });
});
