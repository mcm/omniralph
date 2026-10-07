/**
 * Cache of code-host credentials minted per repository (e.g. GitLab
 * `read_repository` project access tokens). Tokens are encrypted at rest with
 * `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import { repositories, scmCredentialCache } from "./schema.js";

export interface ScmCredential {
  token: string;
  expiresAt: Date;
  /** Provider-side token ID, for rotation/revocation. */
  externalId: string | null;
}

/** Repository as the SCM adapters identify it (structurally `@omniralph/scm`'s `RepoRef`). */
export interface ScmRepoRef {
  fullPath: string;
  externalId?: string;
}

type EncryptionKey = string | Buffer | undefined;

export async function getScmCredential(
  db: Database,
  repositoryId: string,
  scope: string,
  key?: EncryptionKey,
): Promise<ScmCredential | null> {
  const [row] = await db
    .select()
    .from(scmCredentialCache)
    .where(
      and(eq(scmCredentialCache.repositoryId, repositoryId), eq(scmCredentialCache.scope, scope)),
    )
    .limit(1);
  if (!row) return null;
  return {
    token: decrypt(row.encryptedToken, key),
    expiresAt: row.expiresAt,
    externalId: row.externalId,
  };
}

/** Stores (or replaces) the credential for a repository and scope. */
export async function saveScmCredential(
  db: Database,
  repositoryId: string,
  scope: string,
  credential: ScmCredential,
  key?: EncryptionKey,
): Promise<void> {
  const values = {
    encryptedToken: encrypt(credential.token, key),
    expiresAt: credential.expiresAt,
    externalId: credential.externalId,
  };
  await db
    .insert(scmCredentialCache)
    .values({ repositoryId, scope, ...values })
    .onConflictDoUpdate({
      target: [scmCredentialCache.repositoryId, scmCredentialCache.scope],
      set: { ...values, createdAt: new Date() },
    });
}

/**
 * A credential cache for one SCM connection, keyed like the SCM adapters'
 * `CredentialCache` (`RepoRef` + scope). Repositories are matched by
 * provider ID when given, else by path.
 */
export function createScmCredentialCache(db: Database, connectionId: string, key?: EncryptionKey) {
  async function repositoryId(repo: ScmRepoRef): Promise<string | null> {
    const match = repo.externalId
      ? eq(repositories.externalId, repo.externalId)
      : eq(repositories.fullPath, repo.fullPath);
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.connectionId, connectionId), match))
      .limit(1);
    return row?.id ?? null;
  }

  return {
    async get(repo: ScmRepoRef, scope: string): Promise<ScmCredential | null> {
      const id = await repositoryId(repo);
      return id ? getScmCredential(db, id, scope, key) : null;
    },
    async set(repo: ScmRepoRef, scope: string, credential: ScmCredential): Promise<void> {
      const id = await repositoryId(repo);
      if (!id) throw new Error(`Repository ${repo.fullPath} is not connected`);
      await saveScmCredential(db, id, scope, credential, key);
    },
  };
}
