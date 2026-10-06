import { describe, expect, it } from "vitest";
import {
  agentTopic,
  capabilityTopic,
  defaultCapabilityLimit,
  effectiveCapabilityLimits,
  Heartbeat,
  HeartbeatResponse,
  JobFailure,
  JobMessage,
  JobStartResponse,
} from "./protocol.js";

const ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";

describe("protocol", () => {
  it("names topics per capability and per agent", () => {
    expect(capabilityTopic("review")).toBe("review-jobs");
    expect(agentTopic("review", ID)).toBe(`review-jobs-agent-${ID}`);
    // Vercel Queues topic names are [A-Za-z0-9_-]+.
    expect(agentTopic("review", ID)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("validates job messages", () => {
    expect(JobMessage.safeParse({ jobId: ID }).success).toBe(true);
    expect(JobMessage.safeParse({ jobId: "../x" }).success).toBe(false);
  });

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

  it("defaults the heartbeat's capability limits for older control panels", () => {
    const response = HeartbeatResponse.parse({
      maxConcurrency: 1,
      pollIntervalSeconds: 5,
      enabledCapabilities: [],
      pinnedRepoIds: [],
      topics: [],
      queueRegion: "iad1",
      cancelJobIds: [],
      jobTokens: [],
    });
    expect(response.capabilityLimits).toEqual({});
  });
});
