/**
 * Public review links of work items ("Share review link", `/share/{token}`). The token and
 * password are hashed by the caller (`apps/web/src/lib/work-items/share-links.ts`): only
 * their hashes are stored here.
 */
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { users, workItemShareLinks } from "./schema.js";
import { recordWorkItemEvent, type WorkItemKey } from "./work-items.js";

export type WorkItemShareLink = typeof workItemShareLinks.$inferSelect;

/** A share link with its creator's name (null once the user is deleted or has none). */
export interface WorkItemShareLinkWithCreator extends WorkItemShareLink {
  createdByName: string | null;
}

/** Who acted, for the item's Activity. */
export interface ShareLinkActor {
  userId: string | null;
  name: string;
}

const active = (now: Date) =>
  and(isNull(workItemShareLinks.revokedAt), gt(workItemShareLinks.expiresAt, now));

const ofItem = (key: WorkItemKey) =>
  and(
    eq(workItemShareLinks.organizationId, key.organizationId),
    eq(workItemShareLinks.tracker, key.tracker),
    eq(workItemShareLinks.externalId, key.externalId),
  );

const withCreator = {
  link: workItemShareLinks,
  createdByName: users.name,
};

export interface CreateWorkItemShareLinkInput extends WorkItemKey {
  tokenHash: string;
  passwordHash: string | null;
  expiresAt: Date;
  actor: ShareLinkActor;
  /** At most this many active links per item (the new one included). */
  maxActive: number;
  now?: Date;
}

/**
 * Creates a share link and records `share_link_created` (a live `work_item` change), unless
 * the item already has `maxActive` active links: then `limit` and nothing is written.
 */
export async function createWorkItemShareLink(
  db: Database,
  input: CreateWorkItemShareLinkInput,
): Promise<{ status: "created"; link: WorkItemShareLink } | { status: "limit" }> {
  const { tokenHash, passwordHash, expiresAt, actor, maxActive, now = new Date(), ...key } = input;
  return db.transaction(async (tx) => {
    // Two creates at once can't both pass the count.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`share-links:${key.organizationId}:${key.tracker}:${key.externalId}`}, 0))`,
    );
    const [counted] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workItemShareLinks)
      .where(and(ofItem(key), active(now)));
    if ((counted?.count ?? 0) >= maxActive) return { status: "limit" as const };
    const [link] = await tx
      .insert(workItemShareLinks)
      .values({ ...key, tokenHash, passwordHash, expiresAt, createdBy: actor.userId })
      .returning();
    await recordWorkItemEvent(tx, {
      ...key,
      kind: "share_link_created",
      actorUserId: actor.userId,
      actorName: actor.name,
      detail: { linkId: link!.id, protected: passwordHash !== null },
    });
    return { status: "created" as const, link: link! };
  });
}

/** The item's active links (not revoked, not expired), oldest first. */
export async function listActiveWorkItemShareLinks(
  db: Pick<Database, "select">,
  key: WorkItemKey,
  now: Date = new Date(),
): Promise<WorkItemShareLinkWithCreator[]> {
  const rows = await db
    .select(withCreator)
    .from(workItemShareLinks)
    .leftJoin(users, eq(users.id, workItemShareLinks.createdBy))
    .where(and(ofItem(key), active(now)))
    .orderBy(asc(workItemShareLinks.createdAt), asc(workItemShareLinks.id));
  return rows.map(({ link, createdByName }) => ({ ...link, createdByName }));
}

/** A link by its ID, whatever its state, or null. */
export async function getWorkItemShareLink(
  db: Pick<Database, "select">,
  id: string,
): Promise<WorkItemShareLink | null> {
  const [row] = await db.select().from(workItemShareLinks).where(eq(workItemShareLinks.id, id));
  return row ?? null;
}

/**
 * The active link whose token hashes to `tokenHash`, with its creator's name; null when
 * there's none, or it was revoked or has expired.
 */
export async function findActiveWorkItemShareLink(
  db: Pick<Database, "select">,
  tokenHash: string,
  now: Date = new Date(),
): Promise<WorkItemShareLinkWithCreator | null> {
  const [row] = await db
    .select(withCreator)
    .from(workItemShareLinks)
    .leftJoin(users, eq(users.id, workItemShareLinks.createdBy))
    .where(and(eq(workItemShareLinks.tokenHash, tokenHash), active(now)));
  return row ? { ...row.link, createdByName: row.createdByName } : null;
}

/**
 * Revokes the link and records `share_link_revoked` (a live `work_item` change). Null when it
 * doesn't exist or was already revoked: nothing is written.
 */
export async function revokeWorkItemShareLink(
  db: Database,
  input: { id: string; actor: ShareLinkActor; now?: Date },
): Promise<WorkItemShareLink | null> {
  const { id, actor, now = new Date() } = input;
  return db.transaction(async (tx) => {
    const [link] = await tx
      .update(workItemShareLinks)
      .set({ revokedAt: now })
      .where(and(eq(workItemShareLinks.id, id), isNull(workItemShareLinks.revokedAt)))
      .returning();
    if (!link) return null;
    await recordWorkItemEvent(tx, {
      organizationId: link.organizationId,
      tracker: link.tracker,
      externalId: link.externalId,
      kind: "share_link_revoked",
      actorUserId: actor.userId,
      actorName: actor.name,
      detail: { linkId: link.id },
    });
    return link;
  });
}
