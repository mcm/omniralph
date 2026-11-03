/**
 * The number of the pull request (GitHub `…/pull/7`) or merge request (GitLab
 * `…/-/merge_requests/7`) a browser URL points at; null for any other URL.
 */
export function changeRequestNumberFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /\/(?:pull|-\/merge_requests)\/(\d+)\/?$/.exec(path);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
