import { describe, expect, it } from "vitest";
import {
  acceptedKindsSummary,
  agentStatus,
  compactSince,
  pinBadges,
  versionPolicyLabel,
  versionSummary,
  type AgentStatusInput,
} from "./status";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const idle: AgentStatusInput = {
  revoked: false,
  online: true,
  lastHeartbeatAt: ago(10_000),
  updateStatus: "up_to_date",
  runningCount: 0,
};
const status = (overrides: Partial<AgentStatusInput>) =>
  agentStatus({ ...idle, ...overrides }, NOW);

describe("agentStatus", () => {
  it("reads every branch with its tone", () => {
    expect(status({ revoked: true, online: false })).toEqual({
      kind: "revoked",
      label: "Revoked",
      tone: "neutral",
    });
    expect(status({ online: false, lastHeartbeatAt: ago(3 * DAY + HOUR) })).toEqual({
      kind: "offline",
      label: "Offline 3d",
      tone: "fail",
    });
    expect(status({ online: false, lastHeartbeatAt: null })).toEqual({
      kind: "never_connected",
      label: "Never connected",
      tone: "neutral",
    });
    expect(status({ updateStatus: "failed" })).toEqual({
      kind: "update_failed",
      label: "Update failed",
      tone: "fail",
    });
    expect(status({ runningCount: 2 })).toEqual({
      kind: "running",
      label: "Running 2",
      tone: "run",
    });
    expect(status({ updateStatus: "updating" })).toEqual({
      kind: "updating",
      label: "Updating",
      tone: "neutral",
    });
    expect(status({})).toEqual({ kind: "idle", label: "Idle", tone: "neutral" });
    expect(status({ updateStatus: "manual" }).kind).toBe("idle");
  });

  it("applies the first match: revoked, offline, never connected, update failed, running, updating", () => {
    const everything: Partial<AgentStatusInput> = {
      revoked: true,
      online: false,
      updateStatus: "failed",
      runningCount: 3,
    };
    expect(status(everything).kind).toBe("revoked");
    expect(status({ ...everything, revoked: false }).kind).toBe("offline");
    expect(status({ ...everything, revoked: false, lastHeartbeatAt: null }).kind).toBe(
      "never_connected",
    );
    expect(status({ ...everything, revoked: false, online: true }).kind).toBe("update_failed");
    expect(status({ runningCount: 3, updateStatus: "updating" }).kind).toBe("running");
  });

  it("takes offline from the server's flag, never the heartbeat's age", () => {
    // A heartbeat a day old, still online by the flag: not offline.
    expect(status({ lastHeartbeatAt: ago(DAY) }).kind).toBe("idle");
    // A heartbeat seconds old, offline by the flag: offline.
    expect(status({ online: false, lastHeartbeatAt: ago(10_000) }).label).toBe("Offline 1m");
  });
});

describe("compactSince", () => {
  it("rounds down to minutes, hours or days, at least a minute", () => {
    expect(compactSince(new Date(ago(0)), NOW)).toBe("1m");
    expect(compactSince(new Date(ago(59 * MINUTE)), NOW)).toBe("59m");
    expect(compactSince(new Date(ago(5 * HOUR + 30 * MINUTE)), NOW)).toBe("5h");
    expect(compactSince(new Date(ago(10 * DAY)), NOW)).toBe("10d");
  });
});

describe("versionSummary", () => {
  const latest = { mode: "latest" as const, version: null, target: "2.0.3" };

  it("says every agent is on the target when none is behind or failed", () => {
    expect(versionSummary(latest, { onTarget: 6, behind: 0, updateFailed: 0 })).toEqual({
      kind: "on_target",
      label: "All agents on",
      version: "2.0.3",
      tone: "neutral",
    });
  });

  it("counts agents behind, neutral", () => {
    expect(versionSummary(latest, { onTarget: 4, behind: 2, updateFailed: 0 })).toEqual({
      kind: "behind",
      label: "2 agents behind",
      tone: "neutral",
    });
    expect(versionSummary(latest, { onTarget: 4, behind: 1, updateFailed: 0 }).label).toBe(
      "1 agent behind",
    );
  });

  it("puts a failed update first, coral", () => {
    expect(versionSummary(latest, { onTarget: 4, behind: 2, updateFailed: 1 })).toEqual({
      kind: "update_failed",
      label: "1 update failed",
      tone: "fail",
    });
    expect(versionSummary(null, { onTarget: 0, behind: 0, updateFailed: 3 }).label).toBe(
      "3 updates failed",
    );
  });

  it("labels the policy", () => {
    expect(versionPolicyLabel(latest)).toBe("Track latest");
    expect(versionPolicyLabel({ mode: "pinned", version: "2.0.3", target: "2.0.3" })).toBe(
      "Pinned to 2.0.3",
    );
    expect(versionPolicyLabel({ mode: "unset", version: null, target: null })).toBe(
      "No version set",
    );
    expect(versionPolicyLabel(null)).toBe("Varies by organization");
  });
});

describe("acceptedKindsSummary", () => {
  it("reads all kinds, or how many agents limit them", () => {
    expect(acceptedKindsSummary({ limited: 0, total: 7 })).toBe("Accept all kinds");
    expect(acceptedKindsSummary({ limited: 2, total: 7 })).toBe("2 of 7 agents limit kinds");
    expect(acceptedKindsSummary({ limited: 1, total: 7 })).toBe("1 of 7 agents limits kinds");
    expect(acceptedKindsSummary({ limited: 1, total: 1 })).toBe("1 agent limits kinds");
    expect(acceptedKindsSummary({ limited: 0, total: 0 })).toBe("Accept all kinds");
  });
});

describe("pinBadges", () => {
  const pins = ["a", "b", "c", "d", "e"];

  it("shows one or two pins, else the first and +N", () => {
    expect(pinBadges([])).toEqual({ shown: [], more: 0 });
    expect(pinBadges(pins.slice(0, 1))).toEqual({ shown: ["a"], more: 0 });
    expect(pinBadges(pins.slice(0, 2))).toEqual({ shown: ["a", "b"], more: 0 });
    expect(pinBadges(pins)).toEqual({ shown: ["a"], more: 4 });
  });
});
