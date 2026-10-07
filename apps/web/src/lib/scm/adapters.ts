import "server-only";
import {
  connectionCredentials,
  createScmCredentialCache,
  getScmConnection,
  type Database,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import {
  createAppJwtSigner,
  GitHubAdapter,
  GitLabAdapter,
  gitLabErrorStatus,
  type ScmAdapter,
} from "@omniralph/scm";
import type { JobRepository } from "@omniralph/shared";
import { repositoryWebUrl } from "@/lib/repositories/web-url";

/** Encrypted `scm_connections.encrypted_credentials` of a GitLab connection. */
interface GitLabCredentials extends Record<string, unknown> {
  token: string;
  webhookSecret: string;
}

/** GitHub adapters per connection (each caches its app JWT and installation tokens). */
const githubAdapters = new Map<string, GitHubAdapter>();

function gitLabAdapter(db: Database, connection: ScmConnection): GitLabAdapter {
  const { token, webhookSecret } = connectionCredentials<GitLabCredentials>(connection);
  return new GitLabAdapter({
    token,
    webhookSecret,
    baseUrl: connection.baseUrl,
    credentialCache: createScmCredentialCache(db, connection.id),
  });
}

/**
 * A GitLab adapter that, when GitLab answers 401, reloads the connection's
 * credentials from the database and retries the call once: the daily rotation
 * (`gitlab-maintenance` cron) revokes the bot token this adapter may have been
 * built with.
 */
function reloadingGitLabAdapter(db: Database, connection: ScmConnection): ScmAdapter {
  let adapter = gitLabAdapter(db, connection);
  return new Proxy(adapter, {
    get(_target, property) {
      const value: unknown = Reflect.get(adapter, property, adapter);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(adapter, args);
        } catch (error) {
          if (gitLabErrorStatus(error) !== 401) throw error;
          const reloaded = await getScmConnection(db, connection.organizationId, connection.id);
          if (!reloaded) throw error;
          adapter = gitLabAdapter(db, reloaded);
          const method = Reflect.get(adapter, property, adapter) as (
            ...a: unknown[]
          ) => Promise<unknown>;
          return method.apply(adapter, args);
        }
      };
    },
  });
}

/**
 * The code-host adapter for a connection. GitHub connections act as their
 * installation (`external_id`); GitLab connections use the bot token (reloaded
 * once on a 401, see {@link reloadingGitLabAdapter}) and keep minted clone
 * tokens encrypted in `scm_credential_cache`.
 */
export function scmAdapterFor(db: Database, connection: ScmConnection): ScmAdapter {
  if (connection.provider === "gitlab") return reloadingGitLabAdapter(db, connection);
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
