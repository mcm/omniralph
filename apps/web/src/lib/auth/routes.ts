/** Auth.js session cookie names (the `__Secure-` variant is used over HTTPS). */
export const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"] as const;

export const SIGN_IN_PATH = "/sign-in";
/**
 * Dev-only sign-in by email, without OAuth (`devSignInEnabled()`), for agents rendering
 * the panel against the fixture database. Public as a sub-path of the sign-in page.
 */
export const DEV_SIGN_IN_PATH = `${SIGN_IN_PATH}/dev`;
export const ACCESS_DENIED_PATH = "/access-denied";
/** Where signed-in users without an active organization create, accept or join one. */
export const ONBOARDING_PATH = "/onboarding";
export const TERMS_PATH = "/terms";
export const PRIVACY_PATH = "/privacy";

/**
 * The organization picked on this device (its ID). Not `httpOnly`: open tabs read it to
 * notice a switch made in another tab.
 */
export const ORGANIZATION_COOKIE = "omniralph-organization";
/**
 * `all` while this device shows every organization the user belongs to ("All
 * organizations"); absent for one organization. `ORGANIZATION_COOKIE` still names the
 * single active organization, which pages and `/api/ui` keep acting on. Not `httpOnly`,
 * for the same reason. See `getOrganizationScope()`.
 */
export const ORGANIZATION_SCOPE_COOKIE = "omniralph-organization-scope";
/**
 * Switches this device to the organization in a signed `?token=` and redirects to its next
 * path (pages can't set cookies). See `lib/organizations/enter.ts`.
 */
export const ENTER_ORGANIZATION_PATH = "/api/organizations/enter";

/** Routes that authenticate themselves (agent tokens, webhook signatures, cron secret) or Auth.js. */
const SELF_AUTHENTICATED_PREFIXES = ["/api/agent", "/api/webhooks", "/api/cron", "/api/auth"];
const PUBLIC_PAGES = [SIGN_IN_PATH, ACCESS_DENIED_PATH, TERMS_PATH, PRIVACY_PATH];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * How the proxy treats a request path:
 * - `public`: no session needed (sign-in, access-denied, terms and privacy pages,
 *   self-authenticated APIs)
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
