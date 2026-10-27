/**
 * Full-page navigations that leave the panel's client routing: a connect route that
 * redirects to a provider's OAuth screen, or a provider's own page in a new tab. One module,
 * so screens' tests can mock them (jsdom can't navigate).
 */

/** Loads `url` in this tab (a route handler, e.g. `/api/integrations/linear/connect`). */
export function navigateTo(url: string): void {
  window.location.assign(url);
}

/** Opens `url` in a new tab, without giving it this window. */
export function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
