import { describe, expect, it } from "vitest";
import {
  HarnessVersion,
  harnessVersionAtLeast,
  defaultCapabilityLimit,
  defaultPoolLimit,
  effectiveCapabilityLimits,
  effectivePoolLimits,
  Heartbeat,
  HeartbeatResponse,
  JobFailure,
  JobStartResponse,
  legacyJobRouting,
} from "./protocol.js";

const ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";

describe("protocol", () => {
  it("validates heartbeats", () => {
    expect(
      Heartbeat.safeParse({
        version: "0.1.0",
        capabilities: ["review"],
        runningJobIds: [ID],
        freeSlots: 0,
      }).success,
    ).toBe(true);
    expect(
      Heartbeat.safeParse({ version: "0.1.0", capabilities: [], runningJobIds: [], freeSlots: -1 })
        .success,
    ).toBe(false);
  });

  it("discriminates start responses", () => {
    const skip = JobStartResponse.parse({ action: "skip", reason: "canceled" });
    expect(skip.action).toBe("skip");
    expect(JobStartResponse.safeParse({ action: "run" }).success).toBe(false);
  });

  it("caps retry delays at the maximum lease", () => {
    expect(JobFailure.safeParse({ retryable: true, retryAfterSeconds: 60 }).success).toBe(true);
    expect(JobFailure.safeParse({ retryable: true, retryAfterSeconds: 7200 }).success).toBe(false);
  });

  it("leaves a slot free of ralph jobs by default on agents with two or more slots", () => {
    expect(defaultCapabilityLimit("ralph", 1)).toBe(1);
    expect(defaultCapabilityLimit("ralph", 2)).toBe(1);
    expect(defaultCapabilityLimit("ralph", 4)).toBe(3);
    expect(defaultCapabilityLimit("review", 4)).toBe(4);
  });

  it("clamps stored capability limits to 1…maxConcurrency", () => {
    expect(effectiveCapabilityLimits(["review", "ralph"], {}, 2)).toEqual({ review: 2, ralph: 1 });
    expect(effectiveCapabilityLimits(["review", "ralph"], { ralph: 2, review: 9 }, 3)).toEqual({
      review: 3,
      ralph: 2,
    });
    expect(effectiveCapabilityLimits(["ralph"], { ralph: 0, review: 1 }, 3)).toEqual({ ralph: 1 });
  });

  it("routes every legacy job type to its task type and pool", () => {
    const routing = (type: string) => legacyJobRouting(type);
    expect(routing("review.run")).toEqual({ taskType: "review", pool: "short" });
    for (const type of [
      "review.reply",
      "review.learn-rule",
      "chat.ask",
      "triage.run",
      "ralph.describe-pr",
    ]) {
      expect(routing(type)).toEqual({ taskType: "query", pool: "short" });
    }
    for (const type of ["ralph.story", "ralph.request", "ralph.prepare", "ralph.cleanup"]) {
      expect(routing(type)).toEqual({ taskType: "coding", pool: "long" });
    }
    expect(routing("repo.sync")).toEqual({ taskType: "system", pool: null });
    expect(() => routing("review.unknown")).toThrow(/Unknown legacy job type/);
  });

  it("leaves a slot free of long jobs by default on harnesses with two or more slots", () => {
    expect(defaultPoolLimit("long", 1)).toBe(1);
    expect(defaultPoolLimit("long", 2)).toBe(1);
    expect(defaultPoolLimit("long", 4)).toBe(3);
    expect(defaultPoolLimit("short", 4)).toBe(4);
    expect(defaultPoolLimit("gpu", 4)).toBe(4);
  });

  it("clamps stored pool limits to 1…maxConcurrency", () => {
    expect(effectivePoolLimits({}, 1)).toEqual({ short: 1, long: 1 });
    expect(effectivePoolLimits({}, 3)).toEqual({ short: 3, long: 2 });
    expect(effectivePoolLimits({ long: 3, short: 9 }, 3)).toEqual({ short: 3, long: 3 });
    expect(effectivePoolLimits({ long: 0, gpu: 1 }, 3, ["long", "gpu"])).toEqual({
      long: 1,
      gpu: 1,
    });
  });

  it("requires the agent's organization in the heartbeat response", () => {
    const response = {
      maxConcurrency: 1,
      pollIntervalSeconds: 5,
      acceptedTaskTypes: [],
      poolLimits: {},
      pinnedRepoIds: [],
      topics: [],
      queueRegion: "iad1",
      cancelJobIds: [],
      jobTokens: [],
    };
    expect(HeartbeatResponse.safeParse(response).success).toBe(false);
    expect(HeartbeatResponse.parse({ ...response, organizationId: ID }).organizationId).toBe(ID);
  });
});

describe("self-update protocol", () => {
  it("accepts semver versions only", () => {
    for (const ok of ["1.0.0", "0.1.1", "1.5.0-beta.1", "2.0.0+build.7"]) {
      expect(HarnessVersion.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["latest", "v1.0.0", "1.0", "01.0.0", "1.0.0; rm -rf /", ""]) {
      expect(HarnessVersion.safeParse(bad).success).toBe(false);
    }
  });

  it("stays compatible with agents and control panels that predate self-update", () => {
    const heartbeat = Heartbeat.parse({
      version: "0.1.0",
      capabilities: [],
      runningJobIds: [],
      freeSlots: 0,
    });
    expect(heartbeat.selfUpdate).toBeUndefined();
    expect(heartbeat.update).toBeUndefined();
    expect(heartbeat.failedVersions).toEqual([]);
    const response = HeartbeatResponse.parse({
      maxConcurrency: 1,
      pollIntervalSeconds: 5,
      acceptedTaskTypes: [],
      poolLimits: {},
      pinnedRepoIds: [],
      organizationId: ID,
      topics: [],
      queueRegion: "iad1",
      cancelJobIds: [],
      jobTokens: [],
    });
    expect(response.desiredVersion).toBeNull();
  });

  it("compares agent versions by major, minor and patch", () => {
    expect(harnessVersionAtLeast("0.7.0", "0.7.0")).toBe(true);
    expect(harnessVersionAtLeast("0.10.0", "0.7.0")).toBe(true);
    expect(harnessVersionAtLeast("1.0.0", "0.7.3")).toBe(true);
    expect(harnessVersionAtLeast("0.7.0-beta.1", "0.7.0")).toBe(true);
    expect(harnessVersionAtLeast("0.6.9", "0.7.0")).toBe(false);
    expect(harnessVersionAtLeast("0.7.0", "0.7.1")).toBe(false);
    expect(harnessVersionAtLeast("dev", "0.7.0")).toBe(false);
  });
});
