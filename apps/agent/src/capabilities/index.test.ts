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
  RALPH_PREPARE_TOOL_POLICY,
  ralphCapability,
} from "./ralph/index.js";

describe("capability registry", () => {
  it("ships only the ralph capability, and no system, review or triage capability", () => {
    const registry = new CapabilityRegistry(defaultCapabilities());
    expect(registry.names()).toEqual(["ralph"]);
    expect(registry.forJob({ type: "repo.sync" })).toBeUndefined();
    // Review runs run the review task type (`builtin:review-pr`), by their run spec.
    expect(registry.forJob({ type: "review.run" })).toBeUndefined();
    // Built-in query tasks now (`builtin:learn-rule`, `builtin:reply-to-finding`, `builtin:ask-about-code`, `builtin:triage`), run by the query lifecycle.
    for (const type of ["review.learn-rule", "review.reply", "chat.ask", "triage.run"]) {
      expect(registry.forJob({ type })).toBeUndefined();
    }
    expect(registry.forJob({ type: "review.other" })).toBeUndefined();
    for (const type of ["ralph.prepare", "ralph.cleanup"]) {
      expect(registry.forJob({ type })?.name).toBe("ralph");
    }
    // Stories, requests and PR/MR descriptions run as coding and query tasks, by their run spec.
    for (const type of ["ralph.story", "ralph.request", "ralph.describe-pr"]) {
      expect(registry.forJob({ type })).toBeUndefined();
    }
  });

  it("dispatches by job type, so a type may belong to one capability only", () => {
    const [ralph] = defaultCapabilities() as [Capability];
    expect(
      () =>
        new CapabilityRegistry([ralph, { ...ralph, name: "other", jobTypes: ["ralph.prepare"] }]),
    ).toThrow(/job type 'ralph.prepare' registered twice/);
  });

  it("runs prepare jobs without a writable session", () => {
    const prepare = toolPolicyFor(ralphCapability, "ralph.prepare");
    expect(prepare).toBe(RALPH_PREPARE_TOOL_POLICY);
    expect(prepare.writable).toBe(false);
    expect(prepare.permissionMode).not.toBe("bypassPermissions");
  });

  it("fails ralph job types it doesn't know as not implemented, never as retryable", async () => {
    for (const type of ["ralph.frobnicate", "ralph.story", "ralph.request", "ralph.describe-pr"]) {
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
    const [ralph] = defaultCapabilities() as [Capability];
    expect(() => new CapabilityRegistry([ralph, ralph])).toThrow(/twice/);
  });
});
