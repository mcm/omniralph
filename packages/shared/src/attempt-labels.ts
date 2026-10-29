/**
 * Plain-language sentences for attempts (jobs) and system work (Design rule 4):
 * "Cleaned up the SOC-1719 worktree" rather than `worktree.cleanup`. Pure, so
 * every response that shows an attempt can call it. A raw job type is returned
 * only in its own `type` field, never in a label.
 */
import { CHAT_ASK_JOB_TYPE } from "./chat-ask.js";
import { CORRELATION_JOB_TYPE } from "./correlation.js";
import {
  INSTALL_JOB_TYPE,
  REPO_SYNC_JOB_TYPE,
  WORKTREE_CLEANUP_JOB_TYPE,
  WORKTREE_EXEC_JOB_TYPE,
} from "./protocol.js";
import {
  RALPH_CLEANUP_JOB_TYPE,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_PREPARE_JOB_TYPE,
  RALPH_PUSH_JOB_TYPE,
  RALPH_REQUEST_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
} from "./ralph-job.js";
import { REVIEW_REPLY_JOB_TYPE } from "./reply.js";
import { REVIEW_TASK_JOB_TYPE } from "./review-job.js";
import { LEARN_RULE_JOB_TYPE } from "./rules.js";
import { TRIAGE_RUN_JOB_TYPE } from "./triage-job.js";

/** Job type of the legacy single-pass reviews (before review tasks); no new job has it. */
export const LEGACY_REVIEW_RUN_JOB_TYPE = "review.run";

/** `jobs.status` values. */
export type AttemptStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "expired"
  | "skipped";

/** What a sentence may mention. Every field is optional: a label reads well without it. */
export type AttemptLabelContext = {
  /** Work item identifier, e.g. `SOC-1719`. */
  workItem?: string | null;
  /** The story's work item identifier, e.g. `SOC-1720`. */
  story?: string | null;
  /** The repo's full path or name; only its last path segment is shown. */
  repository?: string | null;
  /** The code host, which decides "pull request" (GitHub) or "merge request" (GitLab). */
  provider?: "github" | "gitlab" | null;
  /** PR/MR number. */
  pullRequestNumber?: number | null;
  /** Installed package name, e.g. `@acme/tools`. */
  packageName?: string | null;
  /** Agent name. */
  agent?: string | null;
  /** Review task name, e.g. `Security`. */
  reviewTask?: string | null;
};

export type AttemptLabelInput = {
  type: string;
  status: AttemptStatus;
  context?: AttemptLabelContext;
};

/** One activity in its three forms: "build X" / "Building X" / "Built X". */
type Phrase = { base: string; progressive: string; past: string };

const RUN_FALLBACK = "this run";
const REPO_FALLBACK = "the repo";

function phrase(base: string, progressive: string, past: string, object: string): Phrase {
  const tail = object ? ` ${object}` : "";
  return { base: `${base}${tail}`, progressive: `${progressive}${tail}`, past: `${past}${tail}` };
}

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The last path segment of a repo's full path ("acme/web/customer-portal" → "customer-portal"). */
export function repositoryName(fullPath: string | null | undefined): string | undefined {
  const segments = present(fullPath)?.split("/").filter(Boolean);
  return segments?.length ? segments[segments.length - 1] : undefined;
}

function pullRequestNoun(context: AttemptLabelContext): string {
  return context.provider === "gitlab" ? "merge request" : "pull request";
}

/** "pull request #42 in customer-portal", "merge request !7", or "the pull request". */
function pullRequestReference(context: AttemptLabelContext): string {
  const noun = pullRequestNoun(context);
  const repo = repositoryName(context.repository);
  const number = context.pullRequestNumber;
  const reference =
    number == null
      ? `the ${noun}`
      : `${noun} ${context.provider === "gitlab" ? "!" : "#"}${number}`;
  return repo ? `${reference} in ${repo}` : reference;
}

function workTarget(context: AttemptLabelContext): string {
  return present(context.story) ?? present(context.workItem) ?? RUN_FALLBACK;
}

/** "the SOC-1719 worktree", or "the worktree for this run". */
function namedThing(identifier: string | undefined, thing: string): string {
  return identifier ? `the ${identifier} ${thing}` : `the ${thing} for ${RUN_FALLBACK}`;
}

const preparation = (c: AttemptLabelContext) =>
  phrase("run", "Running", "Ran", `the preparation commands for ${workTarget(c)}`);
const cleanup = (c: AttemptLabelContext) =>
  phrase(
    "clean up",
    "Cleaning up",
    "Cleaned up",
    namedThing(present(c.story) ?? present(c.workItem), "worktree"),
  );
const review = (c: AttemptLabelContext) => {
  const task = present(c.reviewTask);
  return task
    ? phrase("run", "Running", "Ran", `the ${task} review on ${pullRequestReference(c)}`)
    : phrase("review", "Reviewing", "Reviewed", pullRequestReference(c));
};

const PHRASES: Record<string, (context: AttemptLabelContext) => Phrase> = {
  [RALPH_STORY_JOB_TYPE]: (c) => phrase("build", "Building", "Built", workTarget(c)),
  [RALPH_REQUEST_JOB_TYPE]: (c) =>
    phrase(
      "work on",
      "Working on",
      "Worked on",
      // A request from a chat has no work item: it names its repo.
      `a request in ${present(c.workItem) ?? repositoryName(c.repository) ?? RUN_FALLBACK}`,
    ),
  [RALPH_DESCRIBE_PR_JOB_TYPE]: (c) =>
    phrase(
      "write",
      "Writing",
      "Wrote",
      `the ${pullRequestNoun(c)} description for ${present(c.workItem) ?? RUN_FALLBACK}`,
    ),
  [RALPH_PUSH_JOB_TYPE]: (c) =>
    phrase(
      "push",
      "Pushing",
      "Pushed",
      namedThing(present(c.story) ?? present(c.workItem), "branch"),
    ),
  [RALPH_PREPARE_JOB_TYPE]: preparation,
  [WORKTREE_EXEC_JOB_TYPE]: preparation,
  [RALPH_CLEANUP_JOB_TYPE]: cleanup,
  [WORKTREE_CLEANUP_JOB_TYPE]: cleanup,
  [REPO_SYNC_JOB_TYPE]: (c) =>
    phrase("sync", "Syncing", "Synced", repositoryName(c.repository) ?? REPO_FALLBACK),
  [INSTALL_JOB_TYPE]: (c) => {
    const agent = present(c.agent);
    return phrase(
      "install",
      "Installing",
      "Installed",
      `${present(c.packageName) ?? "a package"}${agent ? ` on ${agent}` : ""}`,
    );
  },
  [REVIEW_TASK_JOB_TYPE]: review,
  [LEGACY_REVIEW_RUN_JOB_TYPE]: review,
  [CORRELATION_JOB_TYPE]: (c) =>
    phrase(
      "combine",
      "Combining",
      "Combined",
      `the review findings for ${pullRequestReference(c)}`,
    ),
  [REVIEW_REPLY_JOB_TYPE]: (c) =>
    phrase("reply", "Replying", "Replied", `to a review comment on ${pullRequestReference(c)}`),
  [LEARN_RULE_JOB_TYPE]: (c) => {
    const repo = repositoryName(c.repository);
    return phrase(
      "learn",
      "Learning",
      "Learned",
      `a review rule from feedback${repo ? ` in ${repo}` : ""}`,
    );
  },
  [TRIAGE_RUN_JOB_TYPE]: (c) =>
    phrase("triage", "Triaging", "Triaged", present(c.workItem) ?? RUN_FALLBACK),
  [CHAT_ASK_JOB_TYPE]: (c) => {
    const repo = repositoryName(c.repository);
    return phrase("answer", "Answering", "Answered", `a question${repo ? ` about ${repo}` : ""}`);
  },
};

const UNKNOWN: Phrase = phrase("run", "Running", "Ran", "a background job");

/** Job types with their own sentence; any other type reads "Ran a background job". */
export const LABELED_JOB_TYPES: readonly string[] = Object.keys(PHRASES);

/**
 * A sentence for an attempt: past tense once completed, present progressive
 * while queued or running, "Couldn't …" when failed, canceled or expired, and
 * "Didn't need to …" when skipped (nothing to do).
 */
export function describeAttempt({ type, status, context = {} }: AttemptLabelInput): string {
  const forms = Object.hasOwn(PHRASES, type) ? PHRASES[type]!(context) : UNKNOWN;
  switch (status) {
    case "queued":
    case "running":
      return forms.progressive;
    case "completed":
      return forms.past;
    case "skipped":
      return `Didn't need to ${forms.base}`;
    case "failed":
    case "canceled":
    case "expired":
      return `Couldn't ${forms.base}`;
  }
}
