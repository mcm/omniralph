import { apiHandler } from "@/lib/api/handler";
import type { AttachmentList } from "@/lib/api/features";
import { loadAttachments, uploadAttachment } from "@/lib/attachments/service";
import { getDb } from "@/lib/db";
import { requireFeature, requireOpenFeature } from "@/lib/features/manage";

type Params = { id: string };

/** A feature's attachments, oldest first. */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<AttachmentList> => {
    const db = getDb();
    const feature = await requireFeature(db, user, params.id);
    return loadAttachments(db, {
      kind: "feature",
      organizationId: feature.organizationId,
      featureId: feature.id,
    });
  },
);

/**
 * Attaches a file to a feature (members): a multipart body with the file in `file`. 201 with
 * the attachment; 413 over the size limit, 400 for a type that can't be attached, 409 for an
 * archived feature, 503 when object storage isn't configured.
 */
export const POST = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ request, user, params }) => {
    const db = getDb();
    const feature = await requireOpenFeature(db, user, params.id);
    return uploadAttachment(
      { db },
      { kind: "feature", organizationId: feature.organizationId, featureId: feature.id },
      request,
      user.id,
    );
  },
);
