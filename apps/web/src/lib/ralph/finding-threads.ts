import {
  listOpenPullRequestFindings,
  resolveOpenFindings,
  type FindingRow,
  type RalphLane,
} from "@omniralph/db";
import type { RalphFindingOutcome } from "@omniralph/shared";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import { quietly } from "./notify";
import { laneRepository } from "./publish";
import type { RalphDeps } from "./run";

/** The reply in a finding's thread, before the session's comment. */
export const FIXED_PREFIX = "Fixed:";
export const SKIPPED_PREFIX = "Not changed:";

export interface FindingThreadsResult {
  /** Findings marked `resolved`. */
  resolved: FindingRow[];
  /** Threads that got a reply. */
  replied: number;
}

/**
 * Settles the review findings a `ralph.request` session reported on: each
 * open finding of the lane's PR/MR gets a reply in its SCM thread with the
 * session's (sanitized) comment; a fixed one is marked `resolved` and its
 * thread resolved. Skipped findings stay open for a person. Findings of
 * other PRs/MRs, unknown or no longer open are ignored. A failed reply or
 * resolve is only logged.
 */
export async function settleFindingThreads(
  deps: RalphDeps,
  lane: RalphLane,
  outcomes: readonly RalphFindingOutcome[],
): Promise<FindingThreadsResult> {
  if (outcomes.length === 0 || lane.prNumber === null) return { resolved: [], replied: 0 };
  const prNumber = lane.prNumber;
  const open = await listOpenPullRequestFindings(deps.db, {
    repositoryId: lane.repositoryId,
    prNumber,
    findingIds: outcomes.map((o) => o.findingId),
  });
  if (open.length === 0) return { resolved: [], replied: 0 };
  const byId = new Map(outcomes.map((o) => [o.findingId, o]));
  const resolved = await resolveOpenFindings(
    deps.db,
    open.filter((f) => byId.get(f.id)?.outcome === "fixed").map((f) => f.id),
  );
  const resolvedIds = new Set(resolved.map((f) => f.id));
  const threads = open.filter(
    (f) =>
      f.scmCommentId !== null && (byId.get(f.id)?.outcome === "skipped" || resolvedIds.has(f.id)),
  );
  if (threads.length === 0) return { resolved, replied: 0 };

  let target: Awaited<ReturnType<typeof laneRepository>>;
  try {
    target = await laneRepository(deps, lane);
  } catch (error) {
    console.warn("couldn't reply in the findings' threads", {
      laneId: lane.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { resolved, replied: 0 };
  }
  const { adapter, repo, repository, connection } = target;
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const allowedHosts = [new URL(webUrl).hostname];

  let replied = 0;
  for (const finding of threads) {
    const commentId = finding.scmCommentId!;
    const { outcome, comment } = byId.get(finding.id)!;
    const prefix = outcome === "fixed" ? FIXED_PREFIX : SKIPPED_PREFIX;
    const body = sanitizeCapped(
      `${prefix} ${comment}`,
      { allowedHosts, author: null },
      MAX_BODY_CHARS,
    );
    const ok = await quietly(`Replying in finding ${finding.id}'s thread`, () =>
      adapter.replyToComment(repo, prNumber, commentId, body),
    );
    if (ok) replied += 1;
    if (outcome === "fixed") {
      await quietly(`Resolving finding ${finding.id}'s thread`, () =>
        adapter.resolveThread(repo, prNumber, commentId),
      );
    }
  }
  return { resolved, replied };
}
