import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api/handler";
import { createShareLinkBodySchema, workItemQuerySchema } from "@/lib/api/work-items";
import { getAppUrl } from "@/lib/app-url";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { resolveWorkItem } from "@/lib/work-items/item";
import { createShareLink, listShareLinks } from "@/lib/work-items/share-link-service";

/** The item's active review links (members), without their tokens. */
export const GET = apiHandler<"member", undefined, typeof workItemQuerySchema, { id: string }>(
  { query: workItemQuerySchema },
  async ({ user, params, query }) => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    return { links: await listShareLinks(db, resolved.key) };
  },
);

/** Share review link (members): a new link, its URL answered once (201). */
export const POST = apiHandler<
  "member",
  typeof createShareLinkBodySchema,
  typeof workItemQuerySchema,
  { id: string }
>(
  { body: createShareLinkBodySchema, query: workItemQuerySchema },
  async ({ request, user, params, query, body }) => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    const created = await createShareLink(
      db,
      resolved,
      { userId: user.id, name: userDisplayName(user) },
      { password: body.password, baseUrl: baseUrl(request) },
    );
    return NextResponse.json(created, { status: 201 });
  },
);

/** The control panel's public URL, else (no `APP_URL`, e.g. locally) the request's origin. */
function baseUrl(request: Request): string {
  try {
    return getAppUrl();
  } catch {
    return new URL(request.url).origin;
  }
}
