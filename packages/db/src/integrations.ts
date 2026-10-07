/**
 * Installed issue-tracker apps (one per provider and organization, e.g. the
 * Omniralph Linear app in one Linear workspace). Credentials are JSON
 * encrypted at rest with `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { createHash } from "node:crypto";
import { and, asc, eq, lt, ne } from "drizzle-orm";
import type { Database } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import { integrations, oauthStateUses } from "./schema.js";

export type IntegrationProvider = (typeof integrations.$inferSelect)["provider"];

export interface Integration {
  id: string;
  organizationId: string;
  provider: IntegrationProvider;
  externalId: string;
  name: string;
  installedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntegrationWithCredentials<C> extends Integration {
  credentials: C;
}

export interface SaveIntegrationInput<C> {
  organizationId: string;
  provider: IntegrationProvider;
  externalId: string;
  name: string;
  credentials: C;
  installedByUserId: string | null;
}

type EncryptionKey = string | Buffer | undefined;
type IntegrationRow = typeof integrations.$inferSelect;

function toIntegration(row: IntegrationRow): Integration {
  const { encryptedCredentials: _, ...rest } = row;
  return rest;
}

function withCredentials<C>(
  row: IntegrationRow,
  key: EncryptionKey,
): IntegrationWithCredentials<C> {
  return {
    ...toIntegration(row),
    credentials: JSON.parse(decrypt(row.encryptedCredentials, key)) as C,
  };
}

/** The organization's integration of the provider (without credentials), or null. */
export async function getIntegration(
  db: Database,
  organizationId: string,
  provider: IntegrationProvider,
): Promise<Integration | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
    )
    .limit(1);
  return row ? toIntegration(row) : null;
}

/**
 * The integration of a provider-side workspace (e.g. a Linear workspace ID),
 * or null: webhooks resolve their organization from it.
 */
export async function getIntegrationByExternalId(
  db: Database,
  provider: IntegrationProvider,
  externalId: string,
): Promise<Integration | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.provider, provider), eq(integrations.externalId, externalId)))
    .limit(1);
  return row ? toIntegration(row) : null;
}

/** The organization's integration of the provider with its decrypted credentials, or null. */
export async function getIntegrationWithCredentials<C>(
  db: Database,
  organizationId: string,
  provider: IntegrationProvider,
  key?: EncryptionKey,
): Promise<IntegrationWithCredentials<C> | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
    )
    .limit(1);
  return row ? withCredentials<C>(row, key) : null;
}

/**
 * Installs (or reinstalls) the provider's integration of an organization for a
 * workspace. An organization connects one workspace per provider
 * (`integrations_provider_uq`): its other workspace's row is removed, and
 * concurrent installs end with the last one. A workspace belongs to one
 * organization (`integrations_provider_external_id_uq`): when another
 * organization has it connected, nothing changes and the result is
 * `"other_organization"`.
 */
export async function saveIntegration<C>(
  db: Database,
  input: SaveIntegrationInput<C>,
  key?: EncryptionKey,
): Promise<Integration | "other_organization"> {
  const encryptedCredentials = encrypt(JSON.stringify(input.credentials), key);
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ organizationId: integrations.organizationId })
      .from(integrations)
      .where(
        and(
          eq(integrations.provider, input.provider),
          eq(integrations.externalId, input.externalId),
        ),
      )
      .for("update");
    if (owner && owner.organizationId !== input.organizationId) return "other_organization";
    await tx
      .delete(integrations)
      .where(
        and(
          eq(integrations.organizationId, input.organizationId),
          eq(integrations.provider, input.provider),
          ne(integrations.externalId, input.externalId),
        ),
      );
    // Two organizations connecting the workspace at once: the unique index fails the second.
    const [row] = await tx
      .insert(integrations)
      .values({ ...input, encryptedCredentials })
      .onConflictDoUpdate({
        target: [integrations.organizationId, integrations.provider],
        set: {
          externalId: input.externalId,
          name: input.name,
          encryptedCredentials,
          installedByUserId: input.installedByUserId,
          updatedAt: new Date(),
        },
      })
      .returning();
    return toIntegration(row!);
  });
}

/**
 * Removes the organization's integration of the provider; returns the removed
 * row (with credentials, to revoke them).
 */
export async function deleteIntegration<C>(
  db: Database,
  organizationId: string,
  provider: IntegrationProvider,
  key?: EncryptionKey,
): Promise<IntegrationWithCredentials<C> | null> {
  const [row] = await db
    .delete(integrations)
    .where(
      and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
    )
    .returning();
  return row ? withCredentials<C>(row, key) : null;
}

/** Organization IDs with an integration of the provider (e.g. for the reconcile cron). */
export async function listIntegratedOrganizationIds(
  db: Database,
  provider: IntegrationProvider,
): Promise<string[]> {
  const rows = await db
    .select({ organizationId: integrations.organizationId })
    .from(integrations)
    .where(eq(integrations.provider, provider))
    .orderBy(asc(integrations.createdAt), asc(integrations.id));
  return rows.map((r) => r.organizationId);
}

/**
 * Read-modify-write of an integration's credentials under a row lock
 * (`SELECT … FOR UPDATE`), so concurrent token refreshes (in any process)
 * run one at a time: `update` sees the credentials the previous one stored.
 * `update` returns the new credentials to store, or null to keep the current
 * ones. Returns the resulting credentials, or null when the integration is gone.
 */
export async function updateIntegrationCredentials<C>(
  db: Database,
  id: string,
  update: (current: C) => Promise<C | null>,
  key?: EncryptionKey,
): Promise<C | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(integrations).where(eq(integrations.id, id)).for("update");
    if (!row) return null;
    const current = JSON.parse(decrypt(row.encryptedCredentials, key)) as C;
    const next = await update(current);
    if (next === null) return current;
    await tx
      .update(integrations)
      .set({ encryptedCredentials: encrypt(JSON.stringify(next), key), updatedAt: new Date() })
      .where(eq(integrations.id, id));
    return next;
  });
}

/**
 * Marks an OAuth `state` nonce as used; false when it was used before (a
 * replayed callback). `expiresAt` is when the state expires: the record is
 * kept until then, and expired records are swept on the way.
 */
export async function consumeOAuthState(
  db: Database,
  nonce: string,
  expiresAt: Date,
  now: Date = new Date(),
): Promise<boolean> {
  const nonceHash = createHash("sha256").update(nonce).digest("hex");
  await db.delete(oauthStateUses).where(lt(oauthStateUses.expiresAt, now));
  const rows = await db
    .insert(oauthStateUses)
    .values({ nonceHash, expiresAt })
    .onConflictDoNothing()
    .returning({ nonceHash: oauthStateUses.nonceHash });
  return rows.length > 0;
}
