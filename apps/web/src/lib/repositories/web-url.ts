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

/**
 * Browser URL of a file (and optionally its lines) on a branch, from the
 * repository's browser URL (`repositoryWebUrl`).
 */
export function fileWebUrl(
  provider: "github" | "gitlab",
  repositoryUrl: string,
  branch: string,
  file: { path: string; startLine?: number; endLine?: number },
): string {
  const ref = [...branch.split("/"), ...file.path.split("/")].map(encodeURIComponent).join("/");
  const blob =
    provider === "gitlab" ? `${repositoryUrl}/-/blob/${ref}` : `${repositoryUrl}/blob/${ref}`;
  if (file.startLine === undefined) return blob;
  const end = file.endLine !== undefined && file.endLine !== file.startLine ? file.endLine : null;
  if (end === null) return `${blob}#L${file.startLine}`;
  return provider === "gitlab"
    ? `${blob}#L${file.startLine}-${end}`
    : `${blob}#L${file.startLine}-L${end}`;
}
