/**
 * Installed issue-tracker apps (one per provider, e.g. the Omniralph Linear app
 * in one Linear workspace). Credentials are JSON encrypted at rest with
 * `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { createHash } from "node:crypto";
import { and, eq, lt, ne } from "drizzle-orm";
import type { Database } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import { integrations, oauthStateUses } from "./schema.js";

export type IntegrationProvider = (typeof integrations.$inferSelect)["provider"];

export interface Integration {
  id: string;
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

/** The provider's installed integration (without credentials), or null. */
export async function getIntegration(
  db: Database,
  provider: IntegrationProvider,
): Promise<Integration | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.provider, provider))
    .limit(1);
  return row ? toIntegration(row) : null;
}

/** The provider's installed integration with its decrypted credentials, or null. */
export async function getIntegrationWithCredentials<C>(
  db: Database,
  provider: IntegrationProvider,
  key?: EncryptionKey,
): Promise<IntegrationWithCredentials<C> | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.provider, provider))
    .limit(1);
  return row ? withCredentials<C>(row, key) : null;
}

/**
 * Installs (or reinstalls) the provider's integration for a workspace. Only one
 * workspace per provider is connected (`integrations_provider_uq`): any other
 * workspace's row is removed, and concurrent installs end with the last one.
 */
export async function saveIntegration<C>(
  db: Database,
  input: SaveIntegrationInput<C>,
  key?: EncryptionKey,
): Promise<Integration> {
  const encryptedCredentials = encrypt(JSON.stringify(input.credentials), key);
  return db.transaction(async (tx) => {
    await tx
      .delete(integrations)
      .where(
        and(
          eq(integrations.provider, input.provider),
          ne(integrations.externalId, input.externalId),
        ),
      );
    const [row] = await tx
      .insert(integrations)
      .values({ ...input, encryptedCredentials })
      .onConflictDoUpdate({
        target: integrations.provider,
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

/** Removes the provider's integration; returns the removed row (with credentials, to revoke them). */
export async function deleteIntegration<C>(
  db: Database,
  provider: IntegrationProvider,
  key?: EncryptionKey,
): Promise<IntegrationWithCredentials<C> | null> {
  const [row] = await db
    .delete(integrations)
    .where(eq(integrations.provider, provider))
    .returning();
  return row ? withCredentials<C>(row, key) : null;
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
