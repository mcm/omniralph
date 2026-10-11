import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessAuditLog, TokenTheftAlert, type AuditRow } from "./harness-audit-log";

let n = 0;
function entry(event: AuditRow["event"], detail: Record<string, unknown> = {}): AuditRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    event,
    ip: "203.0.113.9",
    detail,
    createdAt: new Date(Date.UTC(2026, 9, 5, 12, 0, n)).toISOString(),
  };
}

const audit: AuditRow[] = [
  entry("result_submitted", { jobId: "abcdef12-0000", status: "completed" }),
  entry("credential_issued", { repository: "acme/api", jobId: "abcdef12-0000" }),
  entry("auth_failed", { reason: "expired", path: "/api/harness/heartbeat" }),
  entry("token_refresh", { familyId: "f" }),
  entry("revoke", { revokedBy: "admin-1", requeuedJobIds: ["a", "b"] }),
  entry("enroll", { name: "coder-host", version: "0.1.0" }),
];

describe("HarnessAuditLog", () => {
  it("renders one row per event, in the given order, with labels and details", () => {
    const html = renderToStaticMarkup(<HarnessAuditLog audit={audit} />);
    const events = [...html.matchAll(/data-event="([a-z_]+)"/g)].map((m) => m[1]);
    expect(events).toEqual([
      "result_submitted",
      "credential_issued",
      "auth_failed",
      "token_refresh",
      "revoke",
      "enroll",
    ]);
    for (const text of [
      "Result submitted",
      "Job abcdef12: completed",
      "Credential issued",
      "Read-only token for acme/api, job abcdef12",
      "Auth failure",
      "expired on /api/harness/heartbeat",
      "Token refresh",
      "Revoked",
      "By an admin, 2 running jobs requeued",
      "Enrolled",
      "Host coder-host, version 0.1.0",
      "203.0.113.9",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("shows an empty state without events", () => {
    expect(renderToStaticMarkup(<HarnessAuditLog audit={[]} />)).toContain("No events yet");
  });
});

describe("TokenTheftAlert", () => {
  it("warns about possible token theft when a refresh_reuse event is present", () => {
    const html = renderToStaticMarkup(
      <TokenTheftAlert audit={[...audit, entry("refresh_reuse", { familyId: "f" })]} />,
    );
    expect(html).toContain("Possible token theft");
    expect(html).toContain('role="alert"');
    expect(html).toContain("from 203.0.113.9");
  });

  it("renders nothing otherwise", () => {
    expect(renderToStaticMarkup(<TokenTheftAlert audit={audit} />)).toBe("");
  });
});
