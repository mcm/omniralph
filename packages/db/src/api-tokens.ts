/**
 * Personal API tokens (You › API tokens): one member's token for one organization. The token
 * is generated and hashed by the caller (`apps/web/src/lib/auth/api-tokens.ts`): only its
 * hash and prefix are stored here.
 */
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "./client.js";
import type { OrganizationRole } from "./organizations.js";
import { apiTokens, organizationMembers, organizations, users } from "./schema.js";
import type { UiTheme } from "./users.js";

export type ApiToken = typeof apiTokens.$inferSelect;

/** At most this many active tokens per member and organization. */
export const MAX_ACTIVE_API_TOKENS = 20;

/** How often `lastUsedAt` is written at most, so busy tokens don't write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

const ofMember = (input: { organizationId: string; userId: string }) =>
  and(eq(apiTokens.organizationId, input.organizationId), eq(apiTokens.userId, input.userId));

export interface CreateApiTokenInput {
  organizationId: string;
  userId: string;
  name: string;
  tokenHash: string;
  prefix: string;
}

/**
 * Creates a token for a member of the organization. `not_member` when the user doesn't
 * belong to it, `limit` at `MAX_ACTIVE_API_TOKENS` active tokens; nothing is written then.
 */
export async function createApiToken(
  db: Database,
  input: CreateApiTokenInput,
): Promise<{ status: "created"; token: ApiToken } | { status: "not_member" | "limit" }> {
  return db.transaction(async (tx) => {
    // Locks the membership row: two creates at once can't both pass the count.
    const [member] = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, input.organizationId),
          eq(organizationMembers.userId, input.userId),
        ),
      )
      .for("update");
    if (!member) return { status: "not_member" as const };
    const active = await tx
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(ofMember(input), isNull(apiTokens.revokedAt)));
    if (active.length >= MAX_ACTIVE_API_TOKENS) return { status: "limit" as const };
    const [token] = await tx.insert(apiTokens).values(input).returning();
    return { status: "created" as const, token: token! };
  });
}

/** The member's active (not revoked) tokens in the organization, newest first. */
export async function listApiTokens(
  db: Pick<Database, "select">,
  input: { organizationId: string; userId: string },
): Promise<ApiToken[]> {
  return db
    .select()
    .from(apiTokens)
    .where(and(ofMember(input), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
}

/**
 * Revokes one of the member's own active tokens in the organization. False when there is
 * no such token (another member's, another organization's, or already revoked).
 */
export async function revokeApiToken(
  db: Pick<Database, "update">,
  input: { organizationId: string; userId: string; id: string; now?: Date },
): Promise<boolean> {
  const revoked = await db
    .update(apiTokens)
    .set({ revokedAt: input.now ?? new Date() })
    .where(and(eq(apiTokens.id, input.id), ofMember(input), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return revoked.length > 0;
}

/** Who an API token acts as: its user, their organization and role in it. */
export interface ApiTokenIdentity {
  tokenId: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    theme: UiTheme | null;
    showAdvanced: boolean;
    soundEnabled: boolean;
    soundVolume: number;
  };
  organization: { id: string; name: string };
  role: OrganizationRole;
}

/**
 * The identity of the active token whose hash is `tokenHash`, while its user is still a
 * member of its organization (with their current role); null otherwise. Records when it
 * was used (at most once a minute).
 */
export async function authenticateApiToken(
  db: Pick<Database, "select" | "update">,
  tokenHash: string,
  now: Date = new Date(),
): Promise<ApiTokenIdentity | null> {
  const [row] = await db
    .select({
      tokenId: apiTokens.id,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        theme: users.theme,
        showAdvanced: users.showAdvanced,
        soundEnabled: users.soundEnabled,
        soundVolume: users.soundVolume,
      },
      organization: { id: organizations.id, name: organizations.name },
      role: organizationMembers.role,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .innerJoin(organizations, eq(organizations.id, apiTokens.organizationId))
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, apiTokens.organizationId),
        eq(organizationMembers.userId, apiTokens.userId),
      ),
    )
    .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)));
  if (!row) return null;
  await db
    .update(apiTokens)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiTokens.id, row.tokenId),
        or(
          isNull(apiTokens.lastUsedAt),
          lt(apiTokens.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)),
        ),
      ),
    );
  return row;
}
