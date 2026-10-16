import "server-only";
import {
  findFindingByScmComment,
  getReviewRun,
  isLinearRun,
  listReviewFindings,
  listReviewRunFindings,
  type Database,
  type FindingRow,
  type RalphLane,
  type Review,
  type RalphRun,
  type Repository,
  type ScmConnection,
  resolveRepositorySwitches,
} from "@omniralph/db";
import {
  buildPullRequestCommentRequest,
  type ChangeRequestWord,
  type ReviewContextText,
} from "@omniralph/ralph";
import type { RepoRef, ScmAdapter } from "@omniralph/scm";
import { FEEDBACK_REASON_LABELS } from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { getLinearGatewayOrDisconnected, lazyLinearGateway } from "@/lib/linear/client";
import type { LinearGateway } from "@/lib/linear/gateway";
import {
  addPullRequestCommentRequest,
  findRalphPullRequest,
  type PullRequestRequestDelivery,
} from "@/lib/ralph/pull-request-requests";
import type { ChatSource } from "@/lib/ralph/conversation";
import type { RalphDeps } from "@/lib/ralph/run";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { enqueueReview, type EnqueueReviewResult } from "@/lib/review/enqueue";
import { inlineCode, MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { dismissFindingWithFeedback } from "@/lib/reviews/feedback";
import type { CommentEvent } from "@/lib/webhooks/events";
import type { BotCommand } from "./commands";
import { enqueueReply } from "./reply";

export interface BotCommandContext {
  db: Database;
  dispatcher: JobDispatcher;
  adapter: ScmAdapter;
  repository: Repository;
  connection: ScmConnection;
  handle: string;
  comment: CommentEvent;
  command: BotCommand;
  /** The code-host adapter of a connection (ralph lanes); default `scmAdapterFor`. */
  adapterFor?: (db: Database, connection: ScmConnection) => ScmAdapter;
  /** The Linear workspace (ralph requests); default: the connected one. */
  linear?: () => Promise<LinearGateway>;
  /** Where ralph runs from chat post (default: the deployment's chat bot). */
  chat?: ChatSource;
}

export type BotCommandOutcome =
  | { status: "refused" }
  | {
      status: "review_enqueued" | "review_duplicate";
      reviewRunId: string;
      /** The review run's first review and job. */
      reviewId: string;
      jobId: string;
      jobIds: string[];
    }
  | { status: "review_unavailable" }
  | { status: "dismissed"; findingId: string }
  | { status: "dismiss_conflict"; findingId: string }
  | { status: "reply_enqueued"; jobId: string }
  /** A question in a finding thread of a repository whose query tasks are turned off. */
  | { status: "query_disabled" }
  | { status: "not_in_finding_thread" }
  /** `@bot fix` or a request on a ralph PR/MR, added to its run. */
  | { status: "ralph_request"; runId: string; delivery: PullRequestRequestDelivery }
  /** The ralph run is over (failed, or a newer run of the issue is under way). */
  | { status: "ralph_unavailable"; runId: string }
  /** `@bot fix` on a PR/MR ralph didn't open. */
  | { status: "not_ralph" }
  | { status: "help" };

/**
 * Commands that change state need write access to the repository. Questions
 * in a finding's thread (which spend tokens) are checked where they're handled.
 */
const PRIVILEGED: ReadonlySet<BotCommand["kind"]> = new Set(["review", "dismiss", "fix"]);

/** The command list, in code spans so posting it can't trigger a command. */
function helpText(handle: string): string {
  const cmd = (text: string) => inlineCode(`@${handle} ${text}`);
  return [
    "Here's what I can do:",
    "",
    `- ${cmd("review")}: review the whole diff again for new issues (optionally ${cmd("review quick")}, ${cmd("review standard")} or ${cmd("review deep")}).`,
    `- ${cmd("review fresh")}: review the whole diff from scratch, raising issues again even if they're already open (also with a profile, e.g. ${cmd("review fresh deep")}).`,
    `- ${cmd("dismiss [reason]")} in one of my finding's threads: dismiss the finding (reasons: false positive, won't fix, not relevant, other).`,
    `- ${cmd("fix [what to change]")} on a pull/merge request Omniralph opened: Omniralph makes the change and pushes it (in one of my finding's threads, it fixes that finding).`,
    `- Mention me with a question in a finding's thread and I'll answer it.`,
  ].join("\n");
}

const PROFILE_NAMES: Record<string, string> = {
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
};

/**
 * Runs a `@bot` command from a PR/MR comment and replies in the comment's
 * thread (or the conversation). On a PR/MR ralph opened, `@bot fix [text]`
 * and other text outside finding threads become requests for its ralph run
 * (`requestRalph`); so does other text in a finding's thread when the run is
 * followed in a Linear agent session, carrying the finding's whole review. `review`, `dismiss`, `fix`, questions in a finding's
 * thread and ralph requests need write access to the repository
 * (`ScmAdapter.hasWriteAccess`); others get a polite refusal.
 * Every reply goes through the output sanitizer.
 */
export async function runBotCommand(ctx: BotCommandContext): Promise<BotCommandOutcome> {
  const { db, dispatcher, adapter, repository, connection, comment, command, handle } = ctx;
  const repo: RepoRef = { fullPath: repository.fullPath, externalId: repository.externalId };
  const author = comment.author.username;
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const respond = async (text: string, linkHosts: readonly string[] = []) => {
    const body = sanitizeCapped(
      text,
      { allowedHosts: [new URL(webUrl).hostname, ...linkHosts], author },
      MAX_BODY_CHARS,
    );
    if (comment.replyTo.kind === "thread") {
      await adapter.replyToComment(repo, comment.number, comment.replyTo.commentId, body);
    } else {
      await adapter.postComment(repo, comment.number, body);
    }
  };

  const codingEnabled = async () => (await resolveRepositorySwitches(db, repository)).coding;

  const refuse = async (what: string): Promise<BotCommandOutcome> => {
    await respond(
      `Sorry @${author}, only people with write access to this repository can ${what}.`,
    );
    return { status: "refused" };
  };

  if (PRIVILEGED.has(command.kind) && !(await adapter.hasWriteAccess(repo, author))) {
    return refuse(`use ${inlineCode(`@${handle} ${command.kind}`)}`);
  }

  const inThread = () =>
    findFindingByScmComment(db, {
      repositoryId: repository.id,
      prNumber: comment.number,
      commentIds: comment.threadIds,
    });

  const ralphLane = () => findRalphPullRequest({ db }, repository.id, comment.number);
  const term = (
    repository.provider === "gitlab" ? "merge request" : "pull request"
  ) satisfies ChangeRequestWord;

  /**
   * Hands a request to the PR/MR's ralph run and says so in the thread, with
   * a link to the Linear issue (if any). From a finding's thread it carries
   * the finding and the rest of its review, as the review itself would.
   */
  const requestRalph = async (
    found: { lane: RalphLane; run: RalphRun },
    text: string | null,
    thread: { finding: FindingRow; review: Review } | null,
  ): Promise<BotCommandOutcome> => {
    const organizationId = repository.organizationId;
    const deps: RalphDeps = {
      db,
      organizationId,
      dispatcher,
      linear: lazyLinearGateway(
        ctx.linear ?? (() => getLinearGatewayOrDisconnected({ db, organizationId })),
      ),
      adapterFor: ctx.adapterFor ?? scmAdapterFor,
      chat: ctx.chat,
    };
    const request = buildPullRequestCommentRequest({
      author,
      text,
      finding: thread?.finding ?? null,
      review: thread ? await reviewContext(db, thread.review) : null,
      prNumber: comment.number,
      prUrl: found.lane.prUrl ?? "",
      branch: found.lane.branch,
      term,
    });
    const result = await addPullRequestCommentRequest(deps, found, {
      text: request,
      author,
      term,
    });
    const { run } = result;
    // A run from chat has no Linear issue: it's followed in its chat thread.
    const linear = isLinearRun(run) ? run : null;
    const issue = !linear
      ? ""
      : linear.linearUrl
        ? ` of [${linear.linearIdentifier}](${linear.linearUrl})`
        : ` of **${linear.linearIdentifier}**`;
    const hosts = linear?.linearUrl ? [new URL(linear.linearUrl).hostname] : [];
    if (result.status === "run_over") {
      const again = linear
        ? `Delegate ${linear.linearIdentifier} to me in Linear again to pick it back up.`
        : "Ask for it again in the chat thread it came from to pick it back up.";
      await respond(
        `Sorry @${author}, the coding task${issue} is over, so I can't work on this ${term}. ${again}`,
        hosts,
      );
      return { status: "ralph_unavailable", runId: run.id };
    }
    const when =
      result.status === "queued"
        ? " once its current step finishes"
        : result.status === "live"
          ? " right away"
          : "";
    const follow = linear ? "Follow along in Linear." : "Follow along in its chat thread.";
    await respond(
      `On it, @${author}: I passed this to the coding task${issue}, which will work on it${when} and push the changes here. ${follow}`,
      hosts,
    );
    return { status: "ralph_request", runId: run.id, delivery: result.status };
  };

  switch (command.kind) {
    case "fix": {
      const found = await ralphLane();
      if (!found || !(await codingEnabled())) {
        await respond(
          `Sorry @${author}, ${inlineCode(`@${handle} fix`)} only works on ${term}s that Omniralph opened.`,
        );
        return { status: "not_ralph" };
      }
      const thread = await inThread();
      return requestRalph(found, command.text, thread);
    }
    case "review": {
      const cr = await adapter.getChangeRequest(repo, comment.number);
      if (cr.state !== "open") {
        const kind = repository.provider === "gitlab" ? "merge request" : "pull request";
        await respond(`Sorry @${author}, this ${cr.state} ${kind} can't be reviewed again.`);
        return { status: "review_unavailable" };
      }
      const result = await enqueueReview(db, dispatcher, {
        repositoryId: repository.id,
        prNumber: comment.number,
        baseSha: cr.startSha ?? cr.baseSha,
        headSha: cr.headSha,
        title: cr.title,
        description: cr.description,
        author: cr.author,
        trigger: "mention",
        mode: command.fresh ? "fresh" : "full",
        profileId: command.profileId,
      });
      const head = inlineCode(cr.headSha.slice(0, 12));
      switch (result.status) {
        case "enqueued": {
          const profile = command.profileId ? `**${PROFILE_NAMES[command.profileId]}** ` : "";
          const kind = command.fresh ? "fresh" : "full";
          await respond(
            `On it, @${author}: a ${kind} ${profile}review of ${head} is queued. I'll post the results here when it's done.`,
          );
          return { status: "review_enqueued", ...reviewRunOf(result) };
        }
        case "duplicate":
          await respond(`A review of ${head} is already queued or running, @${author}.`);
          return { status: "review_duplicate", ...reviewRunOf(result) };
        case "repository_unavailable":
        case "profile_not_found":
        case "no_review_tasks":
          await respond(
            `Sorry @${author}, I can't review this right now: ${
              result.status === "profile_not_found"
                ? "that review profile doesn't exist."
                : result.status === "no_review_tasks"
                  ? "none of this repository's review tasks reviews on request."
                  : "reviews are disabled for this repository."
            }`,
          );
          return { status: "review_unavailable" };
      }
      break;
    }
    case "dismiss": {
      const found = await inThread();
      if (!found) {
        await respond(
          `${inlineCode(`@${handle} dismiss`)} only works in the thread of one of my findings, @${author}.`,
        );
        return { status: "not_in_finding_thread" };
      }
      const result = await dismissFindingWithFeedback(
        db,
        {
          findingId: found.finding.id,
          source: "scm",
          reason: command.reason,
          note: command.note,
          scmUsername: author,
        },
        dispatcher,
      );
      if (result.status !== "ok") {
        const status = result.status === "conflict" ? result.finding.status : "gone";
        await respond(`This finding is already ${status}, @${author}.`);
        return { status: "dismiss_conflict", findingId: found.finding.id };
      }
      const label = FEEDBACK_REASON_LABELS[command.reason].toLowerCase();
      // No rule generation when it wasn't enqueued (e.g. the repository's query tasks are off).
      const learn = result.learnRuleJobId
        ? " I'll learn from it so later reviews don't raise it again."
        : "";
      await respond(`Thanks @${author}, I dismissed this finding (${label}).${learn}`);
      return { status: "dismissed", findingId: found.finding.id };
    }
    case "question": {
      const found = await inThread();
      if (!found) {
        // Outside finding threads on a ralph PR/MR: a request for ralph.
        const ralph = (await codingEnabled()) ? await ralphLane() : null;
        if (ralph) {
          if (!(await adapter.hasWriteAccess(repo, author))) {
            return refuse("ask for changes");
          }
          return requestRalph(ralph, command.text, null);
        }
        await respond(helpText(handle));
        return { status: "help" };
      }
      if (!(await adapter.hasWriteAccess(repo, author))) {
        return refuse("ask me about findings");
      }
      // In a review thread of a ralph PR/MR followed in a Linear agent session:
      // routed to that session with the review's context, like the review itself.
      const ralph = (await codingEnabled()) ? await ralphLane() : null;
      if (ralph && isLinearRun(ralph.run) && ralph.run.status !== "failed") {
        return requestRalph(ralph, command.text, found);
      }
      const result = await enqueueReply(db, dispatcher, {
        finding: found.finding,
        review: found.review,
        question: command.text,
        askedBy: author,
        commentId: comment.commentId,
      });
      if (result.status === "enqueued" || result.status === "duplicate") {
        return { status: "reply_enqueued", jobId: result.jobId };
      }
      // Query tasks are turned off for the repository: skipped without a reply.
      if (result.status === "query_disabled") return { status: "query_disabled" };
      await respond(`Sorry @${author}, I can't answer questions for this repository right now.`);
      return { status: "review_unavailable" };
    }
    case "help":
      await respond(helpText(handle));
      return { status: "help" };
  }
  throw new Error("unreachable");
}

/**
 * The review a finding's thread belongs to, for a ralph request: its review
 * run's summary and open findings (a review from before review runs: its own),
 * ordered as the review's own request orders them.
 */
async function reviewContext(db: Database, review: Review): Promise<ReviewContextText> {
  const run = review.reviewRunId ? await getReviewRun(db, review.reviewRunId) : null;
  const rows = run
    ? await listReviewRunFindings(db, run.id)
    : await listReviewFindings(db, review.id);
  const findings = rows
    .filter((f) => f.status === "open")
    .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return { summary: run?.summary ?? null, findings };
}

/** What a mention's result reports of an enqueued (or already active) review run. */
function reviewRunOf(result: Extract<EnqueueReviewResult, { status: "enqueued" | "duplicate" }>) {
  return {
    reviewRunId: result.reviewRunId,
    reviewId: result.reviewId,
    jobId: result.jobId,
    jobIds: result.runs.map((run) => run.jobId),
  };
}
