import { describe, expect, it } from "vitest";
import {
  AcceptedTaskTypes,
  ClaimRequest,
  AgentVersion,
  agentVersionAtLeast,
  defaultPoolLimit,
  effectivePoolLimits,
  Heartbeat,
  HeartbeatResponse,
  agentWakeChannel,
  HostToolName,
  InstallPayload,
  JobFailure,
  JobStartResponse,
  isSystemRpc,
  legacyJobRouting,
  orgWakeChannel,
  SYSTEM_RPCS,
} from "./protocol.js";

const ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";

describe("protocol", () => {
  it("validates heartbeats", () => {
    expect(
      Heartbeat.safeParse({
        version: "0.1.0",
        runningJobIds: [ID],
        freeSlots: 0,
      }).success,
    ).toBe(true);
    expect(
      Heartbeat.safeParse({ version: "0.1.0", runningJobIds: [], freeSlots: -1 }).success,
    ).toBe(false);
  });

  it("defaults a heartbeat's installables to none, so older agents validate", () => {
    const base = { version: "0.1.0", runningJobIds: [], freeSlots: 0 };
    expect(Heartbeat.parse(base).installables).toEqual([]);
    const installables = [{ name: "@omniralph/hello", version: "1.0.0" }];
    expect(Heartbeat.parse({ ...base, installables }).installables).toEqual(installables);
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ name: `p${i}`, version: "1.0.0" }));
    expect(Heartbeat.safeParse({ ...base, installables: tooMany }).success).toBe(false);
    expect(
      Heartbeat.safeParse({ ...base, installables: [{ name: "", version: "1.0.0" }] }).success,
    ).toBe(false);
  });

  it("defaults a heartbeat's models to none, so older agents validate", () => {
    const base = { version: "0.1.0", runningJobIds: [], freeSlots: 0 };
    expect(Heartbeat.parse(base).models).toEqual([]);
    const models = [{ value: "opus", displayName: "Opus" }];
    expect(Heartbeat.parse({ ...base, models }).models).toEqual(models);
    expect(
      Heartbeat.safeParse({ ...base, models: [{ value: "", displayName: "Empty" }] }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ value: `m${i}`, displayName: "M" }));
    expect(Heartbeat.safeParse({ ...base, models: tooMany }).success).toBe(false);
  });

  it("accepts an optional host, so older agents validate", () => {
    const base = { version: "0.1.0", runningJobIds: [], freeSlots: 0 };
    expect(Heartbeat.parse(base).host).toBeUndefined();
    const plain = { hostname: "build-01", coder: null };
    expect(Heartbeat.parse({ ...base, host: plain }).host).toEqual(plain);
    const coder = { hostname: "ws-1", coder: { owner: "steve", workspace: "omniralph" } };
    expect(Heartbeat.parse({ ...base, host: coder }).host).toEqual(coder);
    expect(
      Heartbeat.safeParse({ ...base, host: { hostname: "x".repeat(255), coder: null } }).success,
    ).toBe(true);
    expect(
      Heartbeat.safeParse({ ...base, host: { hostname: "x".repeat(256), coder: null } }).success,
    ).toBe(false);
    expect(Heartbeat.safeParse({ ...base, host: { hostname: "build-01" } }).success).toBe(false);
    expect(
      Heartbeat.safeParse({ ...base, host: { hostname: "ws-1", coder: { owner: "steve" } } })
        .success,
    ).toBe(false);
  });

  it("defaults a heartbeat's host tools to none and validates them", () => {
    const base = { version: "0.1.0", runningJobIds: [], freeSlots: 0 };
    expect(Heartbeat.parse(base).hostTools).toEqual([]);
    const hostTools = [
      { name: "opengrep", configuredPathExists: null, discoveredPath: "/usr/bin/opengrep" },
      { name: "semgrep", configuredPathExists: false, discoveredPath: null },
    ];
    expect(Heartbeat.parse({ ...base, hostTools }).hostTools).toEqual(hostTools);
    const tooMany = Array.from({ length: 101 }, (_, i) => ({
      name: `t${i}`,
      configuredPathExists: null,
      discoveredPath: null,
    }));
    expect(Heartbeat.safeParse({ ...base, hostTools: tooMany }).success).toBe(false);
    expect(
      Heartbeat.safeParse({
        ...base,
        hostTools: [{ name: "opengrep", configuredPathExists: null, discoveredPath: "bin/x" }],
      }).success,
    ).toBe(false);
  });

  it("accepts host tool names of lowercase letters, digits, dots, dashes and underscores", () => {
    for (const ok of ["opengrep", "a", "code-graph", "tool_1.2", "9lives", "a".repeat(64)]) {
      expect(HostToolName.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["", "-x", ".x", "_x", "Opengrep", "a/b", "a b", "a".repeat(65)]) {
      expect(HostToolName.safeParse(bad).success).toBe(false);
    }
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

  it("routes every legacy job type to its task type", () => {
    const routing = (type: string) => legacyJobRouting(type);
    for (const type of ["review.reply", "review.learn-rule", "chat.ask", "triage.run"]) {
      expect(routing(type)).toEqual({ taskType: "query" });
    }
    for (const type of ["ralph.prepare", "ralph.cleanup"]) {
      expect(routing(type)).toEqual({ taskType: "coding" });
    }
    // Stories, requests and PR/MR descriptions are task runs, never legacy jobs.
    for (const type of ["ralph.story", "ralph.request", "ralph.describe-pr"]) {
      expect(() => routing(type)).toThrow(/Unknown legacy job type/);
    }
    expect(routing("repo.sync")).toEqual({ taskType: "system" });
    expect(routing("worktree.exec")).toEqual({ taskType: "system" });
    expect(routing("worktree.cleanup")).toEqual({ taskType: "system" });
    expect(() => routing("review.unknown")).toThrow(/Unknown legacy job type/);
    // Review runs are review task runs (`review.task`, run specs), not a legacy job type.
    expect(() => routing("review.run")).toThrow(/Unknown legacy job type/);
  });

  it("lists the system RPCs, each routed as a system job", () => {
    expect(SYSTEM_RPCS).toEqual(["repo.sync", "worktree.exec", "worktree.cleanup", "install"]);
    for (const name of SYSTEM_RPCS) {
      expect(legacyJobRouting(name)).toEqual({ taskType: "system" });
    }
    expect(isSystemRpc("repo.sync")).toBe(true);
    expect(isSystemRpc("worktree.exec")).toBe(true);
    expect(isSystemRpc("worktree.cleanup")).toBe(true);
    expect(isSystemRpc("install")).toBe(true);
    expect(isSystemRpc("ralph.prepare")).toBe(false);
    expect(isSystemRpc("review.run")).toBe(false);
  });

  it("accepts only an npm package name and a version or dist-tag in install payloads", () => {
    const ok = (payload: unknown) => InstallPayload.safeParse(payload).success;
    expect(ok({ name: "@omniralph/code-graph" })).toBe(true);
    expect(ok({ name: "@omniralph/code-graph", version: "1.2.3" })).toBe(true);
    expect(ok({ name: "semgrep-wrapper", version: "next" })).toBe(true);
    expect(ok({ name: "@omniralph/code-graph", version: "1.2.3-beta.1" })).toBe(true);
    // Anything npm could read as another package, a URL, a path or a range.
    expect(ok({ name: "@omniralph/x", version: "npm:evil@1.0.0" })).toBe(false);
    expect(ok({ name: "@omniralph/x", version: "file:../evil" })).toBe(false);
    expect(ok({ name: "@omniralph/x", version: "github:evil/evil" })).toBe(false);
    expect(ok({ name: "@omniralph/x", version: "^1.0.0" })).toBe(false);
    expect(ok({ name: "@omniralph/x", version: "" })).toBe(false);
    expect(ok({ name: "./evil.tgz" })).toBe(false);
    expect(ok({ name: "https://evil.example/x.tgz" })).toBe(false);
    expect(ok({ name: "evil/evil" })).toBe(false);
    expect(ok({ name: "-g" })).toBe(false);
    expect(ok({ name: "Upper" })).toBe(false);
  });

  it("leaves a slot free of long jobs by default on agents with two or more slots", () => {
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
    // Only `short` and `long` are pools: a stored limit for any other name is ignored.
    expect(effectivePoolLimits({ long: 0, gpu: 1 }, 3)).toEqual({ short: 3, long: 1 });
  });

  it("carries the agent's own accepted task types in heartbeats and claims, optional for older agents", () => {
    const heartbeat = { version: "0.1.0", runningJobIds: [], freeSlots: 0 };
    expect(Heartbeat.parse(heartbeat).acceptedTaskTypes).toBeUndefined();
    expect(
      Heartbeat.parse({ ...heartbeat, acceptedTaskTypes: ["review"] }).acceptedTaskTypes,
    ).toEqual(["review"]);
    expect(ClaimRequest.parse({ pools: ["short"] }).acceptedTaskTypes).toBeUndefined();
    expect(
      ClaimRequest.parse({ pools: ["short"], acceptedTaskTypes: ["query", "coding"] })
        .acceptedTaskTypes,
    ).toEqual(["query", "coding"]);
    // A non-empty subset of the task types, each once; `system` is always accepted, never listed.
    for (const bad of [[], ["system"], ["deploy"], ["review", "review"], "review"]) {
      expect(AcceptedTaskTypes.safeParse(bad).success).toBe(false);
      expect(Heartbeat.safeParse({ ...heartbeat, acceptedTaskTypes: bad }).success).toBe(false);
      expect(ClaimRequest.safeParse({ pools: [], acceptedTaskTypes: bad }).success).toBe(false);
    }
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
      expect(AgentVersion.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["latest", "v1.0.0", "1.0", "01.0.0", "1.0.0; rm -rf /", ""]) {
      expect(AgentVersion.safeParse(bad).success).toBe(false);
    }
  });

  it("stays compatible with agents and control panels that predate self-update", () => {
    const heartbeat = Heartbeat.parse({
      version: "0.1.0",
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
    expect(response.hostTools).toEqual([]);
  });

  it("stays compatible with agents and control panels that predate Ably wake-ups", () => {
    const heartbeat = Heartbeat.parse({ version: "0.1.0", runningJobIds: [], freeSlots: 0 });
    expect(heartbeat.ablyTokenExpiresAt).toBeUndefined();
    const expiresAt = "2026-10-16T00:00:00.000Z";
    expect(
      Heartbeat.parse({
        version: "0.1.0",
        runningJobIds: [],
        freeSlots: 1,
        ablyTokenExpiresAt: expiresAt,
      }).ablyTokenExpiresAt,
    ).toBe(expiresAt);
    expect(
      Heartbeat.safeParse({
        version: "0.1.0",
        runningJobIds: [],
        freeSlots: 1,
        ablyTokenExpiresAt: "soon",
      }).success,
    ).toBe(false);

    const base = {
      maxConcurrency: 1,
      acceptedTaskTypes: [],
      poolLimits: {},
      pinnedRepoIds: [],
      organizationId: ID,
      cancelJobIds: [],
      jobTokens: [],
    };
    expect(HeartbeatResponse.parse(base).ably).toBeUndefined();
    expect(HeartbeatResponse.parse({ ...base, ably: null }).ably).toBeNull();
    const ably = { token: "a.b.c", expiresAt };
    expect(HeartbeatResponse.parse({ ...base, ably }).ably).toEqual(ably);
  });

  it("carries the claimable pools and the claimable flag, both optional", () => {
    const heartbeat = { version: "0.1.0", runningJobIds: [], freeSlots: 1 };
    expect(Heartbeat.parse(heartbeat).claimablePools).toBeUndefined();
    expect(Heartbeat.parse({ ...heartbeat, claimablePools: ["short"] }).claimablePools).toEqual([
      "short",
    ]);
    expect(Heartbeat.parse({ ...heartbeat, claimablePools: [] }).claimablePools).toEqual([]);
    expect(Heartbeat.safeParse({ ...heartbeat, claimablePools: [""] }).success).toBe(false);
    expect(
      Heartbeat.safeParse({ ...heartbeat, claimablePools: Array(33).fill("short") }).success,
    ).toBe(false);

    const base = {
      maxConcurrency: 1,
      acceptedTaskTypes: [],
      poolLimits: {},
      pinnedRepoIds: [],
      organizationId: ID,
      cancelJobIds: [],
      jobTokens: [],
    };
    expect(HeartbeatResponse.parse(base).claimable).toBeUndefined();
    expect(HeartbeatResponse.parse({ ...base, claimable: true }).claimable).toBe(true);
    expect(HeartbeatResponse.parse({ ...base, claimable: false }).claimable).toBe(false);
  });

  it("names the Ably wake channels", () => {
    expect(agentWakeChannel(ID)).toBe(`agent:${ID}`);
    expect(orgWakeChannel(ID)).toBe(`org:${ID}`);
  });

  it("compares agent versions by major, minor and patch", () => {
    expect(agentVersionAtLeast("0.7.0", "0.7.0")).toBe(true);
    expect(agentVersionAtLeast("0.10.0", "0.7.0")).toBe(true);
    expect(agentVersionAtLeast("1.0.0", "0.7.3")).toBe(true);
    expect(agentVersionAtLeast("0.7.0-beta.1", "0.7.0")).toBe(true);
    expect(agentVersionAtLeast("0.6.9", "0.7.0")).toBe(false);
    expect(agentVersionAtLeast("0.7.0", "0.7.1")).toBe(false);
    expect(agentVersionAtLeast("dev", "0.7.0")).toBe(false);
  });
});
