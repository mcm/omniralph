import { apiHandler } from "@/lib/api/handler";
import type { AttachmentList } from "@/lib/api/features";
import { workItemQuerySchema } from "@/lib/api/work-items";
import { loadAttachments, uploadAttachment } from "@/lib/attachments/service";
import { getDb } from "@/lib/db";
import { resolveWorkItem } from "@/lib/work-items/item";

type Params = { id: string };

/** A work item's attachments, oldest first. */
export const GET = apiHandler<"member", undefined, typeof workItemQuerySchema, Params>(
  { query: workItemQuerySchema },
  async ({ user, params, query }): Promise<AttachmentList> => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    return loadAttachments(db, { kind: "work_item", ...resolved.key });
  },
);

/**
 * Attaches a file to a work item (members): a multipart body with the file in `file`. 201
 * with the attachment; 413 over the size limit, 400 for a type that can't be attached, 503
 * when object storage isn't configured.
 */
export const POST = apiHandler<"member", undefined, typeof workItemQuerySchema, Params>(
  { query: workItemQuerySchema },
  async ({ request, user, params, query }) => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    return uploadAttachment({ db }, { kind: "work_item", ...resolved.key }, request, user.id);
  },
);
