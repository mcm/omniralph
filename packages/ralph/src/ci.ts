/**
 * The request for a failed CI run on a ralph PR/MR (ported from cyralph's
 * `buildCiFailureRequest`, `src/git/ci.ts`): the failed jobs and the tails of
 * their logs, as the text a `ralph.request` session works from.
 */
import type { ChangeRequestWord } from "./reviews.js";

/** The most failed jobs one request lists (with their logs). */
export const MAX_CI_REQUEST_JOBS = 5;
/** The most of a job log's end a request keeps. */
export const MAX_CI_REQUEST_LOG = 4000;

/** A failed CI job, with its log (empty or missing when it couldn't be read). */
export interface CiFailedJobText {
  name: string;
  url?: string | null;
  log?: string | null;
}

/** The request handed to the agent for one failed CI run of the PR/MR's head commit. */
export function buildCiFailureRequest(args: {
  prNumber: number;
  prUrl: string;
  headSha: string;
  branch: string;
  jobs: readonly CiFailedJobText[];
  term?: ChangeRequestWord;
}): string {
  const { prNumber, prUrl, headSha, branch, jobs } = args;
  const term = args.term ?? "pull request";
  const gitlab = term === "merge request";
  const what = gitlab ? `merge request !${prNumber}` : `pull request #${prNumber}`;
  const ci = gitlab ? "GitLab CI pipeline" : "GitHub Actions checks";
  const lines = [
    `The ${ci} for ${what} (${prUrl}) failed on \`${headSha.slice(0, 7)}\`. Fix it on \`${branch}\`:`,
    "- Find the cause in the failed jobs below (the end of each job's log is included) and reproduce it locally where you can.",
    "- Fix the code, tests or CI configuration at fault. Don't skip, disable or weaken tests or checks just to make it pass.",
    "- If the failure has nothing to do with this branch (a flaky test, an infrastructure or network problem), don't change code for it; say so in your summary.",
    `- Run the quality gates, commit, and push \`${branch}\` so CI runs again.`,
    "",
    "Failed jobs:",
  ];
  for (const job of jobs.slice(0, MAX_CI_REQUEST_JOBS)) {
    lines.push("", `### ${job.name}${job.url ? ` (${job.url})` : ""}`);
    const log = job.log?.trim();
    if (log) {
      lines.push(
        "```",
        log.length > MAX_CI_REQUEST_LOG + 1 ? `…${log.slice(-MAX_CI_REQUEST_LOG)}` : log,
        "```",
      );
    } else {
      lines.push("(no log available)");
    }
  }
  if (jobs.length > MAX_CI_REQUEST_JOBS) {
    lines.push("", `(${jobs.length - MAX_CI_REQUEST_JOBS} more failed jobs not shown.)`);
  }
  return lines.join("\n").trim();
}
