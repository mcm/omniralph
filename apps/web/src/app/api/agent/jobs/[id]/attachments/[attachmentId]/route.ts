import { getJobForAgent } from "@omniralph/db";
import { MAX_ATTACHMENT_BYTES, RalphAttachmentId } from "@omniralph/shared";
import { requireJob } from "@/lib/agent-auth/verify";
import { jobIdParam, notFound } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { hasCapability } from "@omniralph/tracker";
import { getTrackerGateway, TrackerNotConnectedError } from "@/lib/tracker/client";
import { runAttachment } from "@/lib/runs/attachments";
import { liveRoute } from "@/lib/live/request";

interface AttachmentRouteContext {
  params: Promise<{ id: string; attachmentId: string }>;
}

function forbidden(error: string): Response {
  return Response.json({ error }, { status: 403 });
}

/** The download failed; `reason` is what the agent tells the session (e.g. `HTTP 401`). */
function failed(status: number, reason: string): Response {
  return Response.json({ error: "download_failed", reason }, { status });
}

const TOO_LARGE = `larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`;

/** `body`, erroring once more than `max` bytes went through. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(new Error(TOO_LARGE));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Streams a file uploaded to the tracker (a screenshot, mockup or document of the
 * run) to a running job whose run lists it (`runAttachment`: a ralph run's
 * attachments, or `attachments` in the run's trigger context; 404 otherwise),
 * fetched with the control panel's tracker credentials, which agents never hold.
 * Needs the job's own token (session or legacy) with `run:attachments`. HTML (a sign-in page instead of the file)
 * and files over 25 MB are rejected; a failed download answers
 * `{ error: "download_failed", reason }`.
 */
async function get(req: Request, ctx: AttachmentRouteContext): Promise<Response> {
  const principal = await requireJob(req, "run:attachments");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  if (jobId !== principal.jobId) return forbidden("job_mismatch");
  const attachmentId = RalphAttachmentId.safeParse((await ctx.params).attachmentId);
  if (!attachmentId.success) return notFound();
  const db = getDb();
  const job = await getJobForAgent(db, jobId, principal.agentId);
  if (!job) return notFound();
  const attachment = await runAttachment(db, job, attachmentId.data);
  if (!attachment) return notFound();

  let download;
  try {
    const tracker = await getTrackerGateway({ db, organizationId: attachment.organizationId });
    // A tracker without uploads never listed any attachment, so this is a gone one.
    if (!hasCapability(tracker, "uploads")) return notFound();
    download = await tracker.uploads.downloadUpload(attachment.url, req.signal);
  } catch (error) {
    if (error instanceof TrackerNotConnectedError) {
      return failed(503, "the run's organization has no tracker connected");
    }
    console.error("downloading a tracker attachment failed", error);
    return failed(502, error instanceof Error ? error.message : String(error));
  }
  if (!download.ok || !download.body) {
    await download.body?.cancel();
    return failed(502, `HTTP ${download.status}`);
  }
  // A sign-in page instead of the file means the token wasn't accepted.
  if (download.contentType === "text/html") {
    await download.body.cancel();
    return failed(502, "got an HTML page instead of the file");
  }
  if (download.contentLength !== null && download.contentLength > MAX_ATTACHMENT_BYTES) {
    await download.body.cancel();
    return failed(413, TOO_LARGE);
  }
  return new Response(capped(download.body, MAX_ATTACHMENT_BYTES), {
    headers: {
      "content-type": download.contentType || "application/octet-stream",
      ...(download.contentLength !== null && { "content-length": String(download.contentLength) }),
      "cache-control": "no-store",
    },
  });
}

export const GET = liveRoute(get);
