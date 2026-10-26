import "server-only";
import { createAgentEnrollment, getAgentEnrollmentStatus, type Database } from "@omniralph/db";
import { getAppUrl } from "@/lib/app-url";
import type { CreatedEnrollment, EnrollmentStatus } from "@/lib/api/harnesses";
import { enrollCommand } from "./display";

/** The control panel URL harnesses should use: `APP_URL`, else the URL this request came in on. */
export function serverUrl(headers: Headers): string {
  try {
    return getAppUrl();
  } catch {
    const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost:3000";
    const proto =
      headers.get("x-forwarded-proto") ??
      (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
}

/**
 * Creates a one-time enrollment token (valid for 1 hour) for a new harness of
 * `organizationId`; `name` (blank: the host's own) is the harness's name.
 */
export async function createEnrollment(
  db: Database,
  input: { organizationId: string; createdBy: string; name: string; serverUrl: string },
): Promise<CreatedEnrollment> {
  const enrollment = await createAgentEnrollment(db, {
    organizationId: input.organizationId,
    name: input.name || null,
    createdBy: input.createdBy,
  });
  return {
    ok: true,
    id: enrollment.id,
    token: enrollment.token,
    expiresAt: enrollment.expiresAt.toISOString(),
    command: enrollCommand(input.serverUrl, enrollment.token),
  };
}

/** An enrollment of `organizationId` and the harness that redeemed it, or null when there's none. */
export async function enrollmentStatus(
  db: Database,
  organizationId: string,
  enrollmentId: string,
): Promise<EnrollmentStatus | null> {
  const status = await getAgentEnrollmentStatus(db, organizationId, enrollmentId);
  return (
    status && { id: status.id, expiresAt: status.expiresAt.toISOString(), harness: status.agent }
  );
}
