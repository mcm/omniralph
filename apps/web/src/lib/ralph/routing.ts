/**
 * Matching a reply to the repository question (`matchSelection`). Issues and
 * the stories of epics route with the organization's rules
 * (`@/lib/routing/resolve`). Matching ignores case.
 */
import { normalizeRepoPath } from "@omniralph/ralph";

/** A repository the question offers: matched by its full path. */
export interface RoutableRepository {
  fullPath: string;
}

const lastSegment = (path: string) => normalizeRepoPath(path).split("/").pop() ?? "";

/** Whether `name` names the repository: its full path or the last segment of it. */
function namesRepository(name: string, repository: RoutableRepository): boolean {
  const t = normalizeRepoPath(name);
  return t === normalizeRepoPath(repository.fullPath) || t === lastSegment(repository.fullPath);
}

/**
 * Matches a reply to the repository question (cyralph's `matchSelection`), in
 * order: a 1-based option number, the option text (the full path), a
 * repository name (the full path or its last segment), then a reply that
 * contains a repository's full path.
 */
export function matchSelection<R extends RoutableRepository>(
  reply: string,
  candidates: readonly R[],
): R | undefined {
  const text = reply.trim();
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (n >= 1 && n <= candidates.length) return candidates[n - 1];
  const said = text.toLowerCase();
  return (
    candidates.find((r) => r.fullPath.trim().toLowerCase() === said) ??
    candidates.find((r) => namesRepository(text, r)) ??
    mentionedRepository(said, candidates)
  );
}

/**
 * The repository whose full path a reply contains (e.g. its URL), as a whole
 * path: `platform/api` doesn't match `platform/api-v2`, and the longest path
 * wins, so the URL of `group/platform/api` picks it over `platform/api`.
 */
function mentionedRepository<R extends RoutableRepository>(
  said: string,
  candidates: readonly R[],
): R | undefined {
  let best: { repository: R; length: number } | undefined;
  for (const repository of candidates) {
    const path = normalizeRepoPath(repository.fullPath);
    if (!path || (best && path.length <= best.length)) continue;
    const whole = new RegExp(`(?:^|[^\\w.-])${escapeRegExp(path)}(?![\\w-])`);
    if (whole.test(said)) best = { repository, length: path.length };
  }
  return best?.repository;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
