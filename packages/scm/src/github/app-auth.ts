import { Octokit } from "@octokit/rest";
import type { AppJwt, AppJwtSigner } from "./app-jwt.js";

export const GITHUB_API_URL = "https://api.github.com";

/** Tokens are refreshed this long before GitHub expires them. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/** App JWTs are re-signed this long before they expire. */
const JWT_EXPIRY_MARGIN_MS = 60 * 1000;

export type InstallationPermissions = Record<string, "read" | "write" | "admin">;

/** Narrows an installation token to some repositories and permissions. */
export interface InstallationTokenScope {
  /** Repository names (without the owner). */
  repositories?: string[];
  permissions?: InstallationPermissions;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface GitHubAppAuthOptions {
  appId: string;
  signer: AppJwtSigner;
  /** REST API base URL; `https://<host>/api/v3` for GitHub Enterprise Server. */
  baseUrl?: string;
  userAgent?: string;
  now?: () => number;
}

function scopeKey(installationId: number, scope?: InstallationTokenScope): string {
  const repositories = [...(scope?.repositories ?? [])].sort();
  const permissions = Object.entries(scope?.permissions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([installationId, repositories, permissions]);
}

/**
 * GitHub App authentication: app JWTs from an {@link AppJwtSigner}, exchanged
 * for installation tokens with `POST /app/installations/{id}/access_tokens`.
 * Tokens are cached per installation and scope until shortly before expiry.
 *
 * The exchange is done directly (through Octokit) rather than with
 * `@octokit/auth-app`, which signs JWTs itself from a PEM and can't use a
 * KMS-signed JWT. See docs/adr/0002-agent-auth.md.
 */
export class GitHubAppAuth {
  readonly appId: string;
  readonly baseUrl: string;
  private readonly signer: AppJwtSigner;
  private readonly userAgent: string;
  private readonly now: () => number;
  private appJwt: Promise<AppJwt> | undefined;
  private readonly tokens = new Map<string, Promise<InstallationToken>>();
  private readonly installationIds = new Map<string, Promise<number>>();

  constructor(options: GitHubAppAuthOptions) {
    this.appId = options.appId;
    this.signer = options.signer;
    this.baseUrl = (options.baseUrl ?? GITHUB_API_URL).replace(/\/+$/, "");
    this.userAgent = options.userAgent ?? "omniralph";
    this.now = options.now ?? Date.now;
  }

  /** An Octokit client authenticated with an installation token. */
  octokit(token: string): Octokit {
    return new Octokit({ auth: token, baseUrl: this.baseUrl, userAgent: this.userAgent });
  }

  /** An Octokit client authenticated as the app (`Authorization: Bearer <app JWT>`). */
  appOctokit(jwt: string): Octokit {
    const octokit = new Octokit({ baseUrl: this.baseUrl, userAgent: this.userAgent });
    octokit.hook.before("request", (options) => {
      options.headers.authorization = `Bearer ${jwt}`;
    });
    return octokit;
  }

  async getAppJwt(): Promise<string> {
    const cached = this.appJwt;
    if (cached) {
      const jwt = await cached.catch(() => undefined);
      if (jwt && jwt.expiresAt.getTime() - JWT_EXPIRY_MARGIN_MS > this.now()) return jwt.token;
      if (this.appJwt === cached) this.appJwt = undefined;
    }
    this.appJwt ??= this.signer.sign(this.appId);
    return (await this.appJwt).token;
  }

  /** An installation token, cached per installation and scope until near expiry. */
  async getInstallationToken(
    installationId: number,
    scope?: InstallationTokenScope,
  ): Promise<InstallationToken> {
    const key = scopeKey(installationId, scope);
    const cached = this.tokens.get(key);
    if (cached) {
      const token = await cached.catch(() => undefined);
      if (token && token.expiresAt.getTime() - EXPIRY_MARGIN_MS > this.now()) return token;
      if (this.tokens.get(key) === cached) this.tokens.delete(key);
    }
    let pending = this.tokens.get(key);
    if (!pending) {
      pending = this.createInstallationToken(installationId, scope);
      this.tokens.set(key, pending);
      // Failed requests aren't cached.
      pending.catch(() => {
        if (this.tokens.get(key) === pending) this.tokens.delete(key);
      });
    }
    return pending;
  }

  /** The installation ID of the app on `owner/repo`, cached. */
  async getRepoInstallationId(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`.toLowerCase();
    let pending = this.installationIds.get(key);
    if (!pending) {
      pending = this.getAppJwt().then(async (jwt) => {
        const { data } = await this.appOctokit(jwt).apps.getRepoInstallation({ owner, repo });
        return data.id;
      });
      this.installationIds.set(key, pending);
      pending.catch(() => {
        if (this.installationIds.get(key) === pending) this.installationIds.delete(key);
      });
    }
    return pending;
  }

  private async createInstallationToken(
    installationId: number,
    scope?: InstallationTokenScope,
  ): Promise<InstallationToken> {
    const jwt = await this.getAppJwt();
    const { data } = await this.appOctokit(jwt).apps.createInstallationAccessToken({
      installation_id: installationId,
      ...(scope?.repositories ? { repositories: scope.repositories } : {}),
      ...(scope?.permissions ? { permissions: scope.permissions } : {}),
    });
    return { token: data.token, expiresAt: new Date(data.expires_at) };
  }
}
