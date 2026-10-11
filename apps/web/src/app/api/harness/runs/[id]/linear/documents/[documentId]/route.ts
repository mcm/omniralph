import { LinearEntityId } from "@omniralph/shared";
import { notFound } from "@/lib/harness-api/jobs";
import { runLinearDocument, serveRunLinearTool } from "@/lib/runs/linear";

interface DocumentRouteContext {
  params: Promise<{ id: string; documentId: string }>;
}

/** `linear_get_document`: a document (by ID or slug ID) of the run's organization's Linear workspace. */
export async function GET(req: Request, ctx: DocumentRouteContext): Promise<Response> {
  const documentId = LinearEntityId.safeParse((await ctx.params).documentId);
  if (!documentId.success) return notFound();
  return serveRunLinearTool(req, ctx, "linear_get_document", async (linear) => ({
    document: runLinearDocument(await linear.getDocument(documentId.data)),
  }));
}
