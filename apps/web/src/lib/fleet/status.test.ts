import { agentAuditEvent } from "@omniralph/db";
import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS } from "@/lib/agents/display";
import {
  acceptedKindsSummary,
  agentStatus,
  agentStatusLine,
  auditEventLabel,
  compactSince,
  pinBadges,
  relativeAgo,
  securityLine,
  versionsBehind,
  versionPolicyLabel,
  versionSummary,
  type AgentStatusInput,
  type AgentStatusLineInput,
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

describe("agentStatusLine", () => {
  const line = (overrides: Partial<AgentStatusLineInput>) => {
    const input = {
      ...idle,
      version: "2.0.3",
      desiredVersion: "2.0.3",
      revokedAt: null,
      ...overrides,
    };
    return agentStatusLine({ ...input, status: agentStatus(input, NOW) });
  };

  it("says what the agent does and where its version stands", () => {
    expect(line({ runningCount: 2 })).toEqual({ label: "Running · up to date", tone: "run" });
    expect(line({})).toEqual({ label: "Idle · up to date", tone: "neutral" });
    expect(line({ desiredVersion: null })).toEqual({ label: "Idle · up to date", tone: "neutral" });
    expect(
      line({
        online: false,
        lastHeartbeatAt: ago(3 * DAY),
        version: "2.0.2",
        updateStatus: "manual",
      }),
    ).toEqual({ label: "Offline 3d · 1 version behind", tone: "fail" });
    expect(line({ version: "1.9.0", updateStatus: "manual" })).toEqual({
      label: "Idle · behind 2.0.3",
      tone: "neutral",
    });
  });

  it("names a failed update's version, an update in progress, revocation and no connection", () => {
    expect(line({ version: "2.0.2", desiredVersion: "2.0.4", updateStatus: "failed" })).toEqual({
      label: "Update failed: 2.0.4",
      tone: "fail",
    });
    expect(
      line({ online: false, lastHeartbeatAt: ago(DAY), version: "2.0.2", updateStatus: "failed" }),
    ).toEqual({ label: "Offline 1d · update failed", tone: "fail" });
    expect(line({ version: "2.0.2", updateStatus: "updating" })).toEqual({
      label: "Updating to 2.0.3",
      tone: "neutral",
    });
    expect(line({ revoked: true, online: false, revokedAt: "2026-10-20T12:00:00.000Z" })).toEqual({
      label: "Revoked Oct 20",
      tone: "neutral",
    });
    expect(line({ online: false, lastHeartbeatAt: null })).toEqual({
      label: "Never connected",
      tone: "neutral",
    });
  });
});

describe("versionsBehind", () => {
  it("counts patches on one minor line, else names the target", () => {
    expect(versionsBehind("2.0.1", "2.0.3")).toBe("2 versions behind");
    expect(versionsBehind("2.0.2", "2.0.3")).toBe("1 version behind");
    expect(versionsBehind("1.9.9", "2.0.3")).toBe("behind 2.0.3");
    expect(versionsBehind(null, "2.0.3")).toBe("behind 2.0.3");
    expect(versionsBehind("2.0.3-beta.1", "2.0.3")).toBe("behind 2.0.3");
  });
});

describe("relativeAgo", () => {
  it("rounds down to the largest unit", () => {
    expect(relativeAgo(ago(10_000), NOW)).toBe("just now");
    expect(relativeAgo(ago(MINUTE), NOW)).toBe("1 minute ago");
    expect(relativeAgo(ago(2 * MINUTE + 5_000), NOW)).toBe("2 minutes ago");
    expect(relativeAgo(ago(3 * HOUR), NOW)).toBe("3 hours ago");
    expect(relativeAgo(ago(DAY), NOW)).toBe("1 day ago");
  });
});

describe("securityLine", () => {
  const security = {
    lastTokenRefreshAt: ago(2 * MINUTE),
    reuseAlerts30d: 0,
    lastReuseAt: null,
    connected: true,
  };

  it("says when the token was refreshed, with no reuse alerts", () => {
    expect(securityLine(security, NOW)).toEqual({
      label: "Token refreshed 2 minutes ago · no reuse alerts",
      tone: "neutral",
    });
    expect(securityLine({ ...security, lastTokenRefreshAt: null }, NOW)).toEqual({
      label: "Token not refreshed yet · no reuse alerts",
      tone: "neutral",
    });
  });

  it("reports token reuse in the fail tone", () => {
    expect(
      securityLine(
        { ...security, reuseAlerts30d: 2, lastReuseAt: "2026-10-20T12:00:00.000Z" },
        NOW,
      ),
    ).toEqual({ label: "Token reuse detected Oct 20", tone: "fail" });
  });

  it("says Never connected before the first heartbeat", () => {
    expect(securityLine({ ...security, lastTokenRefreshAt: null, connected: false }, NOW)).toEqual({
      label: "Never connected",
      tone: "neutral",
    });
  });
});

describe("auditEventLabel", () => {
  it("lists every agent_audit_event value", () => {
    expect([...AUDIT_EVENTS].sort()).toEqual([...agentAuditEvent.enumValues].sort());
  });

  it("says what happened, in a sentence, for every event", () => {
    const labels = Object.fromEntries(
      agentAuditEvent.enumValues.map((event) => [
        event,
        auditEventLabel({ event, actor: "Steve McMaster" }),
      ]),
    );
    expect(labels).toEqual({
      enroll: "Enrolled",
      token_refresh: "Refreshed its token",
      refresh_reuse: "Token reuse detected; agent revoked",
      revoke: "Revoked by Steve McMaster",
      delete: "Removed by Steve McMaster",
      credential_issued: "Issued a git credential",
      result_submitted: "Submitted a result",
      auth_failed: "Failed to authenticate",
    });
    for (const [event, label] of Object.entries(labels)) {
      expect(label).not.toContain(event);
      expect(label).not.toMatch(/_/);
    }
  });

  it("leaves out who revoked or removed the agent when nobody is known", () => {
    expect(auditEventLabel({ event: "revoke", actor: null })).toBe("Revoked");
    expect(auditEventLabel({ event: "delete", actor: null })).toBe("Removed");
  });
});
