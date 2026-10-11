import type { JobPayload } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  defaultCapabilities,
  RetryableJobError,
  toolPolicyFor,
  type Capability,
  type JobContext,
} from "./index.js";
import {
  NotImplementedJobError,
  RALPH_DESCRIBE_PR_TOOL_POLICY,
  RALPH_TOOL_POLICY,
  ralphCapability,
} from "./ralph/index.js";
import { REVIEW_TOOL_POLICY } from "./review.js";

describe("capability registry", () => {
  it("ships the review and ralph capabilities, and no system or triage capability", () => {
    const registry = new CapabilityRegistry(defaultCapabilities());
    expect(registry.names()).toEqual(["review", "ralph"]);
    expect(registry.forJob({ type: "repo.sync" })).toBeUndefined();
    expect(registry.forJob({ type: "review.run" })?.name).toBe("review");
    // Built-in query tasks now (`builtin:learn-rule`, `builtin:reply`, `builtin:ask-about-code`, `builtin:triage`), run by the query lifecycle.
    for (const type of ["review.learn-rule", "review.reply", "chat.ask", "triage.run"]) {
      expect(registry.forJob({ type })).toBeUndefined();
    }
    expect(registry.forJob({ type: "review.other" })).toBeUndefined();
    for (const type of ["ralph.story", "ralph.describe-pr", "ralph.prepare"]) {
      expect(registry.forJob({ type })?.name).toBe("ralph");
    }
  });

  it("dispatches by job type, so a type may belong to one capability only", () => {
    const [review, ralph] = defaultCapabilities() as [Capability, Capability];
    expect(
      () => new CapabilityRegistry([review, { ...ralph, name: "other", jobTypes: ["review.run"] }]),
    ).toThrow(/job type 'review.run' registered twice/);
  });

  it("keeps review sessions read-only", () => {
    expect([...REVIEW_TOOL_POLICY.allowedTools].sort()).toEqual(["Glob", "Grep", "Read"]);
    for (const tool of ["Bash", "Write", "Edit", "WebFetch", "WebSearch"]) {
      expect(REVIEW_TOOL_POLICY.disallowedTools).toContain(tool);
    }
    expect(REVIEW_TOOL_POLICY.permissionMode).not.toBe("bypassPermissions");
    expect(REVIEW_TOOL_POLICY.settingSources).toEqual([]);
    expect(REVIEW_TOOL_POLICY.writable).toBe(false);
  });

  it("lets ralph story sessions write, and keeps describe-pr sessions read-only", () => {
    expect(RALPH_TOOL_POLICY).toMatchObject({
      tools: "claude_code",
      permissionMode: "bypassPermissions",
      settingSources: ["user", "project", "local"],
      writable: true,
    });
    expect(toolPolicyFor(ralphCapability, "ralph.story")).toBe(RALPH_TOOL_POLICY);
    const describePr = toolPolicyFor(ralphCapability, "ralph.describe-pr");
    expect(describePr).toBe(RALPH_DESCRIBE_PR_TOOL_POLICY);
    expect(describePr.writable).toBe(false);
    expect(describePr.permissionMode).not.toBe("bypassPermissions");
    for (const tool of ["Write", "Edit", "MultiEdit", "Bash"]) {
      expect(describePr.allowedTools).not.toContain(tool);
      expect(describePr.disallowedTools).toContain(tool);
    }
  });

  it("fails ralph job types it doesn't know as not implemented, never as retryable", async () => {
    for (const type of ["ralph.frobnicate"]) {
      const job: JobPayload = {
        id: "00000000-0000-4000-8000-000000000001",
        type,
        taskType: "coding",
        pool: "long",
        taskId: null,
        repositoryId: null,
        payload: {},
        deliveryCount: 1,
      };
      const error = await ralphCapability.run(job, {} as JobContext).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotImplementedJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect((error as Error).message).toBe(`${type} jobs are not supported by this agent yet`);
    }
  });

  it("rejects duplicate names", () => {
    const [review] = defaultCapabilities() as [Capability];
    expect(() => new CapabilityRegistry([review, review])).toThrow(/twice/);
  });
});
