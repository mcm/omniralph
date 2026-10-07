import "server-only";
import {
  appInstallUrl,
  createAppJwtSigner,
  getAppSlug,
  GITHUB_API_URL,
  GitHubAppAuth,
} from "@omniralph/scm";

let auth: GitHubAppAuth | undefined;
let slug: Promise<string> | undefined;

export function githubApiUrl(): string {
  return (process.env.GITHUB_API_URL ?? GITHUB_API_URL).replace(/\/+$/, "");
}

/** True when the GitHub App's ID and signing key are configured. */
export function isGitHubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
    (process.env.GITHUB_APP_KMS_ISSUER_ID || process.env.GITHUB_APP_PRIVATE_KEY),
  );
}

/** Shared GitHub App auth (app JWTs and installation tokens are cached per instance). */
export function getGitHubAppAuth(): GitHubAppAuth {
  if (!auth) {
    const appId = process.env.GITHUB_APP_ID;
    if (!appId) throw new Error("GITHUB_APP_ID is not set");
    auth = new GitHubAppAuth({
      appId,
      signer: createAppJwtSigner(process.env),
      baseUrl: githubApiUrl(),
    });
  }
  return auth;
}

/**
 * The app's installation page: `GITHUB_APP_SLUG` if set, else the slug from `GET /app`
 * (cached). `null` when the app isn't configured or GitHub can't be reached.
 */
export async function getGitHubInstallUrl(): Promise<string | null> {
  if (process.env.GITHUB_APP_SLUG)
    return appInstallUrl(process.env.GITHUB_APP_SLUG, githubApiUrl());
  if (!isGitHubAppConfigured()) return null;
  slug ??= getAppSlug(getGitHubAppAuth());
  try {
    return appInstallUrl(await slug, githubApiUrl());
  } catch {
    slug = undefined;
    return null;
  }
}

/** The GitHub App's Setup URL path; GitHub sends installations back here. */
export const GITHUB_CALLBACK_PATH = "/repositories/github/callback";
/** Starts an installation with a signed `state` (see `createSignedState`). */
export const GITHUB_INSTALL_PATH = "/repositories/github/install";
/** `createSignedState` purpose of the installation flow. */
export const GITHUB_INSTALL_STATE_PURPOSE = "github-install";
/** Cookie holding the installation state's nonce, binding the flow to the browser that started it. */
export const GITHUB_INSTALL_COOKIE = "omniralph_github_install";
