import { GITHUB_API_URL } from "@omniralph/scm";

/**
 * Browser URL of a repository from its connection's base URL: the GitLab instance URL, or
 * the GitHub REST API URL (`https://api.github.com`, or `https://<host>/api/v3` on GHES).
 */
export function repositoryWebUrl(
  provider: "github" | "gitlab",
  baseUrl: string,
  fullPath: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (provider === "gitlab") return `${base}/${fullPath}`;
  const host = base === GITHUB_API_URL ? "https://github.com" : base.replace(/\/api\/v3$/, "");
  return `${host}/${fullPath}`;
}

/** Browser URL of a pull request (GitHub) or merge request (GitLab). */
export function changeRequestWebUrl(
  provider: "github" | "gitlab",
  baseUrl: string,
  fullPath: string,
  number: number,
): string {
  const repo = repositoryWebUrl(provider, baseUrl, fullPath);
  return provider === "gitlab" ? `${repo}/-/merge_requests/${number}` : `${repo}/pull/${number}`;
}
