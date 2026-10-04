import type { RepoRef } from "./types.js";

/** A code-host token minted for one repository and scope. */
export interface CachedCredential {
  token: string;
  expiresAt: Date;
  /** Provider-side token ID (e.g. the GitLab project access token ID). */
  externalId: string | null;
}

/**
 * Storage for minted repository credentials, so they're reused across
 * requests (and control panel instances) instead of minted per clone. The
 * production implementation is `@omniralph/db`'s `createScmCredentialCache`,
 * which encrypts tokens in `scm_credential_cache`.
 */
export interface CredentialCache {
  get(repo: RepoRef, scope: string): Promise<CachedCredential | null>;
  set(repo: RepoRef, scope: string, credential: CachedCredential): Promise<void>;
}

/** Process-local {@link CredentialCache}, for tests and single-process use. */
export class MemoryCredentialCache implements CredentialCache {
  readonly entries = new Map<string, CachedCredential>();

  private key(repo: RepoRef, scope: string): string {
    return JSON.stringify([repo.externalId ?? repo.fullPath, scope]);
  }

  async get(repo: RepoRef, scope: string): Promise<CachedCredential | null> {
    return this.entries.get(this.key(repo, scope)) ?? null;
  }

  async set(repo: RepoRef, scope: string, credential: CachedCredential): Promise<void> {
    this.entries.set(this.key(repo, scope), credential);
  }
}
