import { getJob, getRun } from "@omniralph/db";
import { MAX_ATTACHMENT_BYTES, RalphAttachmentId } from "@omniralph/shared";
import { z } from "zod";
import { requireJob } from "@/lib/agent-auth/verify";
import { jobIdParam, notFound } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import { isRalphJob } from "@/lib/ralph/activities";

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

/** The attachment IDs a job's payload lists. */
const PayloadAttachments = z.object({
  attachments: z.array(z.object({ id: z.string() })).default([]),
});

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
 * Streams a file uploaded to Linear (a screenshot, mockup or document of the
 * run) to the ralph job that lists it in its payload, fetched with the
 * control panel's Linear token, which agents never hold. Needs the job's own
 * token with `ralph:attachments`. HTML (a sign-in page instead of the file)
 * and files over 25 MB are rejected; a failed download answers
 * `{ error: "download_failed", reason }`.
 */
export async function GET(req: Request, ctx: AttachmentRouteContext): Promise<Response> {
  const principal = await requireJob(req, "ralph:attachments");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  if (jobId !== principal.jobId) return forbidden("job_mismatch");
  const attachmentId = RalphAttachmentId.safeParse((await ctx.params).attachmentId);
  if (!attachmentId.success) return notFound();
  const db = getDb();
  const job = await getJob(db, jobId);
  if (!job) return notFound();
  if (!isRalphJob(job) || !job.ralphRunId) return forbidden("not_a_ralph_job");
  const listed = PayloadAttachments.safeParse(job.payload);
  if (!listed.success || !listed.data.attachments.some((a) => a.id === attachmentId.data)) {
    return forbidden("attachment_not_in_job");
  }
  const link = (await getRun(db, job.ralphRunId))?.attachments[attachmentId.data];
  if (!link) return notFound();

  let download;
  try {
    const linear = await getLinearGateway({ db });
    download = await linear.downloadUpload(link.url, req.signal);
  } catch (error) {
    if (error instanceof LinearNotConnectedError) {
      return failed(503, "no Linear workspace is connected");
    }
    console.error("downloading a Linear attachment failed", error);
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
