/** Auth.js session cookie names (the `__Secure-` variant is used over HTTPS). */
export const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"] as const;

export const SIGN_IN_PATH = "/sign-in";
export const ACCESS_DENIED_PATH = "/access-denied";

/** Routes that authenticate themselves (agent tokens, webhook signatures, cron secret) or Auth.js. */
const SELF_AUTHENTICATED_PREFIXES = ["/api/agent", "/api/webhooks", "/api/cron", "/api/auth"];
const PUBLIC_PAGES = [SIGN_IN_PATH, ACCESS_DENIED_PATH];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * How the proxy treats a request path:
 * - `public`: no session needed (sign-in/access-denied pages, self-authenticated APIs)
 * - `api`: other API routes; unauthenticated requests get a 401
 * - `page`: UI; unauthenticated requests are redirected to sign-in
 */
export function classifyPath(pathname: string): "public" | "api" | "page" {
  if (SELF_AUTHENTICATED_PREFIXES.some((p) => matchesPrefix(pathname, p))) return "public";
  if (PUBLIC_PAGES.some((p) => matchesPrefix(pathname, p))) return "public";
  if (matchesPrefix(pathname, "/api")) return "api";
  return "page";
}

/**
 * Only same-origin relative paths are accepted as post-sign-in redirects, so the
 * `callbackUrl` can't be used as an open redirect.
 */
export function safeCallbackPath(value: string | string[] | undefined | null): string {
  const path = Array.isArray(value) ? value[0] : value;
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return "/";
  return path;
}
