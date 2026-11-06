/**
 * The `claude` CLI's stored login on this machine, and "Refresh sign-in".
 *
 * Off macOS the CLI keeps its OAuth tokens in `<config>/.credentials.json`
 * (`claudeAiOauth`), where `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`, and
 * the account in `~/.claude.json` (`oauthAccount`). When a refresh fails for
 * good, the CLI clears the tokens on disk (`expiresAt: 0`, empty tokens) but
 * keeps `oauthAccount`, so the SDK's `accountInfo()` still names the account:
 * `storedLoginProblem` is what tells such a login apart.
 *
 * "Refresh sign-in" runs the CLI's own manual OAuth flow (PKCE, the
 * `platform.claude.com` callback page that shows `CODE#STATE`) and writes the
 * tokens where the CLI reads them. The macOS keychain isn't supported: there
 * the CLI doesn't read `.credentials.json`.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FetchFn } from "./api.js";
import { writePrivateJson } from "./config.js";

/** The Claude Code app's public OAuth client (the same one `claude` signs in with). */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** The page that shows the `CODE#STATE` to paste. */
export const CLAUDE_OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** The scopes a subscription login asks for. */
export const CLAUDE_OAUTH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
] as const;

/** The token exchange can be slow (well past the CLI's own 15–30 s). */
export const CLAUDE_TOKEN_EXCHANGE_TIMEOUT_MS = 120_000;
/** A started sign-in must be completed within this long. */
export const CLAUDE_SIGN_IN_TTL_MS = 15 * 60_000;

/** Where the CLI keeps its login. */
export interface ClaudeLoginPaths {
  /** `<config>/.credentials.json`. */
  credentials: string;
  /** `~/.claude.json` (`<config>/.claude.json` with `CLAUDE_CONFIG_DIR`). */
  globalConfig: string;
}

export function claudeLoginPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): ClaudeLoginPaths {
  const configDir = env.CLAUDE_CONFIG_DIR;
  return configDir
    ? {
        credentials: path.join(configDir, ".credentials.json"),
        globalConfig: path.join(configDir, ".claude.json"),
      }
    : {
        credentials: path.join(homeDir, ".claude", ".credentials.json"),
        globalConfig: path.join(homeDir, ".claude.json"),
      };
}

/** `.credentials.json`'s `claudeAiOauth`, as far as it matters here. */
export interface StoredClaudeOauth {
  accessToken?: string;
  refreshToken?: string;
  /** ms since epoch; 0 once the CLI cleared a dead login. */
  expiresAt?: number;
  /** ms since epoch, when the server says. */
  refreshTokenExpiresAt?: number | null;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}

export interface ClaudeCredentialsFs {
  readFile(file: string): Promise<string>;
  writePrivateJson(file: string, value: unknown): Promise<void>;
}

export const nodeClaudeCredentialsFs: ClaudeCredentialsFs = {
  readFile: (file) => readFile(file, "utf8"),
  writePrivateJson,
};

/**
 * A JSON object file; null only when it doesn't exist. A file that can't be
 * read, isn't JSON or isn't an object throws: writing over it would lose what
 * it holds.
 */
async function readJsonObject(
  fs: ClaudeCredentialsFs,
  file: string,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("not a JSON object");
  }
  return value as Record<string, unknown>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stored `claudeAiOauth`; null when there's no file or no login in it. */
export async function readStoredClaudeOauth(
  paths: ClaudeLoginPaths,
  fs: ClaudeCredentialsFs = nodeClaudeCredentialsFs,
): Promise<StoredClaudeOauth | null> {
  const file = await readJsonObject(fs, paths.credentials);
  const oauth = file?.claudeAiOauth;
  return oauth !== null && typeof oauth === "object" ? (oauth as StoredClaudeOauth) : null;
}

/**
 * Why a stored login can't work, in a sentence; null when it can (or may: an
 * expired access token with a refresh token is refreshed by the CLI on use).
 */
export function storedLoginProblem(oauth: StoredClaudeOauth, now: number): string | null {
  const hasAccess = typeof oauth.accessToken === "string" && oauth.accessToken.length > 0;
  const hasRefresh = typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0;
  if (!hasAccess && !hasRefresh) {
    return "Claude's sign-in expired and couldn't be refreshed";
  }
  if (
    hasRefresh &&
    typeof oauth.refreshTokenExpiresAt === "number" &&
    oauth.refreshTokenExpiresAt <= now
  ) {
    return "Claude's sign-in expired";
  }
  if (!hasRefresh && (typeof oauth.expiresAt !== "number" || oauth.expiresAt <= now)) {
    return "Claude's sign-in expired";
  }
  return null;
}

/**
 * Checks the stored login: a problem sentence, or null when there's nothing
 * wrong with it or no stored login to check (the macOS keychain, an env var).
 */
export type CheckStoredLogin = () => Promise<string | null>;

export function storedLoginChecker(options: {
  paths: ClaudeLoginPaths;
  fs?: ClaudeCredentialsFs;
  now?: () => number;
}): CheckStoredLogin {
  return async () => {
    let oauth: StoredClaudeOauth | null;
    try {
      oauth = await readStoredClaudeOauth(options.paths, options.fs);
    } catch {
      // An unreadable file isn't proof the login is gone; the SDK read decides.
      return null;
    }
    if (oauth === null) return null;
    return storedLoginProblem(oauth, (options.now ?? Date.now)());
  };
}

/** A sign-in shown to the page. */
export interface ClaudeSignInStart {
  /** Open in a browser; signing in there shows the code to paste. */
  authorizeUrl: string;
  /** ISO time after which the code is no longer accepted. */
  expiresAt: string;
}

/** What a completed sign-in stored. */
export interface ClaudeSignInResult {
  email: string | null;
  subscriptionType: string | null;
  /**
   * Why `~/.claude.json`'s `oauthAccount` wasn't updated (it can't be read or
   * written); the tokens are stored either way. Absent when it was.
   */
  accountNotUpdated?: string;
}

/** A failure the page shows as it is (a 4xx/5xx with this message). */
export class ClaudeSignInError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** `max` for `claude_max`, as the CLI names it. */
const SUBSCRIPTION_TYPES: Record<string, string> = {
  claude_max: "max",
  claude_pro: "pro",
  claude_enterprise: "enterprise",
  claude_team: "team",
};

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
  account?: { uuid?: string; email_address?: string };
  organization?: { uuid?: string; name?: string };
}

interface Profile {
  account?: { uuid?: string; email?: string; display_name?: string };
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    rate_limit_tier?: string;
  };
}

export interface ClaudeSignInOptions {
  paths: ClaudeLoginPaths;
  fetch?: FetchFn;
  fs?: ClaudeCredentialsFs;
  now?: () => number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exchangeTimeoutMs?: number;
}

interface Pending {
  verifier: string;
  state: string;
  expiresAt: number;
}

/**
 * "Refresh sign-in": `start()` makes a PKCE pair and the authorize URL (one
 * sign-in at a time; starting again replaces the last), `complete(code)` takes
 * the `CODE#STATE` the callback page shows, exchanges it, and writes the
 * tokens to `.credentials.json` and the account to `~/.claude.json`, keeping
 * every other key in both files.
 */
export class ClaudeSignIn {
  private pending: Pending | null = null;

  constructor(private readonly options: ClaudeSignInOptions) {}

  /** Why "Refresh sign-in" can't help here; null when it can. */
  unavailable(): string | null {
    const platform = this.options.platform ?? process.platform;
    if (platform === "darwin") {
      return "On macOS Claude keeps its login in the keychain: sign in with `claude` instead";
    }
    const env = this.options.env ?? process.env;
    if (env.ANTHROPIC_API_KEY) {
      return "ANTHROPIC_API_KEY is set, and it wins over a sign-in: remove it from the agent's environment first";
    }
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      return "CLAUDE_CODE_OAUTH_TOKEN is set, and it wins over a sign-in: remove it from the agent's environment first";
    }
    return null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  start(): ClaudeSignInStart {
    const problem = this.unavailable();
    if (problem !== null) throw new ClaudeSignInError(409, problem);
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(32));
    const expiresAt = this.now() + CLAUDE_SIGN_IN_TTL_MS;
    this.pending = { verifier, state, expiresAt };
    const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI);
    url.searchParams.set("scope", CLAUDE_OAUTH_SCOPES.join(" "));
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return { authorizeUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  async complete(input: string): Promise<ClaudeSignInResult> {
    const pending = this.pending;
    if (pending === null || pending.expiresAt <= this.now()) {
      this.pending = null;
      throw new ClaudeSignInError(409, "This sign-in expired: start again");
    }
    const [code, state] = input.trim().split("#");
    if (!code) throw new ClaudeSignInError(400, "Paste the code the sign-in page shows");
    if (state !== undefined && state !== pending.state) {
      throw new ClaudeSignInError(400, "That code is from another sign-in: start again");
    }
    const fs = this.options.fs ?? nodeClaudeCredentialsFs;
    const { credentials, globalConfig } = this.options.paths;
    // Before the code is spent: a `.credentials.json` that can't be read would
    // lose its other keys (MCP logins) to the write, so it stops the sign-in
    // while the same code can still be tried again once the file is fixed.
    let stored: Record<string, unknown>;
    try {
      stored = (await readJsonObject(fs, credentials)) ?? {};
    } catch (error) {
      throw new ClaudeSignInError(
        409,
        `Can't read ${credentials} (${reason(error)}): fix or move it, then save again`,
      );
    }

    const tokens = await this.exchange(code, pending);
    // A code works once: whatever happens next, this sign-in is done.
    this.pending = null;
    const profile = await this.profile(tokens.access_token);
    const orgType = profile?.organization?.organization_type;
    const subscriptionType = orgType ? (SUBSCRIPTION_TYPES[orgType] ?? null) : null;
    const rateLimitTier = profile?.organization?.rate_limit_tier ?? null;
    const now = this.now();

    // `claude` may have rewritten the file during the exchange (up to 2 minutes):
    // keep what it holds now, or what it held before if it can't be read now.
    stored = (await readJsonObject(fs, credentials).catch(() => stored)) ?? {};
    await fs.writePrivateJson(credentials, {
      ...stored,
      claudeAiOauth: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
        expiresAt: now + tokens.expires_in * 1000,
        ...(tokens.refresh_token_expires_in !== undefined && {
          refreshTokenExpiresAt: now + tokens.refresh_token_expires_in * 1000,
        }),
        scopes: (tokens.scope ?? CLAUDE_OAUTH_SCOPES.join(" ")).split(" ").filter(Boolean),
        subscriptionType,
        rateLimitTier,
        clientId: CLAUDE_OAUTH_CLIENT_ID,
      },
    });

    const email = tokens.account?.email_address ?? profile?.account?.email ?? null;
    const accountUuid = tokens.account?.uuid ?? profile?.account?.uuid;
    const organizationUuid = tokens.organization?.uuid ?? profile?.organization?.uuid;
    // `~/.claude.json` is the CLI's big config file: only `oauthAccount` changes. It only
    // names the account, so when it can't be read it's left alone: writing over it would
    // lose the rest, and the tokens are already stored.
    let config: Record<string, unknown> | null;
    try {
      config = await readJsonObject(fs, globalConfig);
    } catch (error) {
      return {
        email,
        subscriptionType,
        accountNotUpdated: `Can't read ${globalConfig} (${reason(error)})`,
      };
    }
    if (config !== null || accountUuid !== undefined) {
      const previous =
        config?.oauthAccount !== null && typeof config?.oauthAccount === "object"
          ? (config.oauthAccount as Record<string, unknown>)
          : {};
      const account = {
        ...config,
        hasCompletedOnboarding: true,
        oauthAccount: {
          ...previous,
          ...(accountUuid !== undefined && { accountUuid }),
          ...(email !== null && { emailAddress: email }),
          ...(organizationUuid !== undefined && { organizationUuid }),
          ...(tokens.organization?.name !== undefined && {
            organizationName: tokens.organization.name,
          }),
        },
      };
      try {
        await fs.writePrivateJson(globalConfig, account);
      } catch (error) {
        return {
          email,
          subscriptionType,
          accountNotUpdated: `Can't write ${globalConfig} (${reason(error)})`,
        };
      }
    }
    return { email, subscriptionType };
  }

  private async exchange(code: string, pending: Pending): Promise<TokenResponse> {
    const fetchFn = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
          client_id: CLAUDE_OAUTH_CLIENT_ID,
          code_verifier: pending.verifier,
          state: pending.state,
        }).toString(),
        signal: AbortSignal.timeout(
          this.options.exchangeTimeoutMs ?? CLAUDE_TOKEN_EXCHANGE_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ClaudeSignInError(
        502,
        timedOut
          ? "Anthropic didn't answer the sign-in in 2 minutes: try again"
          : `Can't reach Anthropic: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 300);
      if (response.status === 400 || response.status === 401) {
        // A rejected code can't be retried; the verifier stays for none.
        this.pending = null;
        throw new ClaudeSignInError(
          400,
          `Anthropic didn't accept that code (${response.status}): start again${text ? ` (${text})` : ""}`,
        );
      }
      throw new ClaudeSignInError(502, `Anthropic's sign-in failed (${response.status})`);
    }
    const body = (await response.json()) as Partial<TokenResponse>;
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new ClaudeSignInError(502, "Anthropic's sign-in answered without a token");
    }
    return body as TokenResponse;
  }

  /** The plan and account; null when the profile can't be read (the tokens still work). */
  private async profile(accessToken: string): Promise<Profile | null> {
    const fetchFn = this.options.fetch ?? fetch;
    try {
      const response = await fetchFn(CLAUDE_OAUTH_PROFILE_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok ? ((await response.json()) as Profile) : null;
    } catch {
      return null;
    }
  }
}
