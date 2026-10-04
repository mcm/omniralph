import "server-only";
import {
  connectionCredentials,
  createScmCredentialCache,
  type Database,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import { createAppJwtSigner, GitHubAdapter, GitLabAdapter, type ScmAdapter } from "@omniralph/scm";
import type { JobRepository } from "@omniralph/shared";
import { repositoryWebUrl } from "@/lib/repositories/web-url";

/** Encrypted `scm_connections.encrypted_credentials` of a GitLab connection. */
interface GitLabCredentials extends Record<string, unknown> {
  token: string;
  webhookSecret: string;
}

/** GitHub adapters per connection (each caches its app JWT and installation tokens). */
const githubAdapters = new Map<string, GitHubAdapter>();

/**
 * The code-host adapter for a connection. GitHub connections act as their
 * installation (`external_id`); GitLab connections use the bot token and keep
 * minted clone tokens encrypted in `scm_credential_cache`.
 */
export function scmAdapterFor(db: Database, connection: ScmConnection): ScmAdapter {
  if (connection.provider === "gitlab") {
    const { token, webhookSecret } = connectionCredentials<GitLabCredentials>(connection);
    return new GitLabAdapter({
      token,
      webhookSecret,
      baseUrl: connection.baseUrl,
      credentialCache: createScmCredentialCache(db, connection.id),
    });
  }
  let adapter = githubAdapters.get(connection.id);
  if (!adapter) {
    const appId = process.env.GITHUB_APP_ID;
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!appId || !webhookSecret) {
      throw new Error("GITHUB_APP_ID and GITHUB_WEBHOOK_SECRET must be set");
    }
    adapter = new GitHubAdapter({
      appId,
      webhookSecret,
      signer: createAppJwtSigner(process.env),
      installationId: Number(connection.externalId),
      baseUrl: connection.baseUrl,
    });
    githubAdapters.set(connection.id, adapter);
  }
  return adapter;
}

/** The repository as agents see it in job payloads (`JobRepository`). */
export function jobRepository(repository: Repository, connection: ScmConnection): JobRepository {
  return {
    provider: repository.provider,
    fullPath: repository.fullPath,
    cloneUrl: `${repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath)}.git`,
  };
}
