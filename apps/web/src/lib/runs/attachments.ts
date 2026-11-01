/**
 * The tracker uploads a run may download through the control panel
 * (`GET /api/agent/jobs/{id}/attachments/{attachmentId}`).
 */
import "server-only";
import { getRun, type Database, type Job } from "@omniralph/db";
import { RalphAttachmentId, RunSpecJobPayload } from "@omniralph/shared";
import { z } from "zod";

/** The attachment IDs a ralph job's payload lists. */
const RalphPayloadAttachments = z.object({
  attachments: z.array(z.object({ id: z.string() })).default([]),
});

/** The attachments a run-spec job's trigger context lists, with their tracker upload URLs. */
const TriggerAttachments = z.object({
  attachments: z
    .array(z.object({ id: RalphAttachmentId, url: z.url(), title: z.string().optional() }))
    .default([]),
});

/** A tracker upload listed for a run, and the organization whose tracker workspace serves it. */
export interface RunAttachment {
  url: string;
  organizationId: string;
}

/**
 * The attachment `attachmentId` listed for a job's run, or null when the run
 * doesn't list it: for a ralph job, listed in its payload and known to its
 * run (`ralph_runs.attachments`); for a run-spec job, listed in its trigger
 * context's `attachments`.
 */
export async function runAttachment(
  db: Database,
  job: Pick<Job, "organizationId" | "ralphRunId" | "taskId" | "payload">,
  attachmentId: string,
): Promise<RunAttachment | null> {
  if (job.ralphRunId) {
    const listed = RalphPayloadAttachments.safeParse(job.payload);
    if (!listed.success || !listed.data.attachments.some((a) => a.id === attachmentId)) {
      return null;
    }
    const run = await getRun(db, job.ralphRunId);
    const link = run?.attachments[attachmentId];
    return run && link ? { url: link.url, organizationId: run.organizationId } : null;
  }
  if (job.taskId === null) return null;
  const payload = RunSpecJobPayload.safeParse(job.payload);
  if (!payload.success) return null;
  const listed = TriggerAttachments.safeParse(payload.data.trigger.context);
  const attachment = listed.success
    ? listed.data.attachments.find((a) => a.id === attachmentId)
    : undefined;
  return attachment ? { url: attachment.url, organizationId: job.organizationId } : null;
}
