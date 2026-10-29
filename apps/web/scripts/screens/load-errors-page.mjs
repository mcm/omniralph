// What a capture counts as a failed load (capture.mjs). `loadErrorsInPage` runs in the page
// (self-contained, like a11y-page.mjs) and `failedApiResponse` on each response; both are
// tested in jsdom (load-errors-page.test.ts).

/**
 * The in-place errors on the page, by their text (its buttons left out): the panel's
 * QueryBoundary (`.query-error`), the Runs `LoadError` (`.or-run-error`), and any empty state
 * or alert saying "Couldn't load …" or "Can't load …" (the agent page's).
 */
export function loadErrorsInPage() {
  const failed = /^(Couldn['’]t|Can['’]t) load\b/;
  const textOf = (element) => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll("button").forEach((button) => button.remove());
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  };
  const found = [
    ...document.querySelectorAll(".query-error, .or-run-error, .or-empty__title, [role='alert']"),
  ].filter(
    (element, index, all) =>
      // An error inside another one is the same error.
      !all.some((other, at) => at !== index && other.contains(element)) &&
      (element.matches(".query-error, .or-run-error") || failed.test(textOf(element))),
  );
  return found.map((element) => textOf(element).slice(0, 300));
}

/** Bodies an API answers besides JSON: a stream of live events. */
const STREAMS = ["text/event-stream"];

/**
 * Why an API response failed, or `null`: a status of 400 or more, or a body that isn't JSON
 * (e.g. Next's HTML not-found page for a route it didn't match). Only `/api/ui/…` on the panel
 * and `/api/…` on the agent page; redirects and empty answers (204, 304, HEAD) pass.
 */
export function failedApiResponse({ surface, method, url, status, contentType }) {
  const path = new URL(url).pathname;
  if (!path.startsWith(surface === "agent" ? "/api/" : "/api/ui/")) return null;
  const what = `${method} ${path}`;
  if (status >= 400) return `${what}: HTTP ${status}${contentType ? ` (${contentType})` : ""}`;
  if ((status >= 300 && status < 400) || status === 204 || method === "HEAD") return null;
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json" || type.endsWith("+json") || STREAMS.includes(type)) {
    return null;
  }
  return `${what}: HTTP ${status} ${type || "without a content type"}, not JSON`;
}
