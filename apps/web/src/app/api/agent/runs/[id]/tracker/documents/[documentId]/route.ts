import { requireCapability } from "@omniralph/tracker";
import { TrackerEntityId } from "@omniralph/shared";
import { notFound } from "@/lib/agent-api/jobs";
import { runTrackerDocument, serveRunTrackerTool } from "@/lib/runs/tracker";
import { liveRoute } from "@/lib/live/request";

interface DocumentRouteContext {
  params: Promise<{ id: string; documentId: string }>;
}

/** `tracker_get_document`: a document (by ID or slug ID) of the run's organization's tracker. */
async function get(req: Request, ctx: DocumentRouteContext): Promise<Response> {
  const documentId = TrackerEntityId.safeParse((await ctx.params).documentId);
  if (!documentId.success) return notFound();
  return serveRunTrackerTool(req, ctx, "tracker_get_document", async (tracker) => ({
    document: runTrackerDocument(
      await requireCapability(tracker, "documents").getDocument(documentId.data),
    ),
  }));
}

export const GET = liveRoute(get);
