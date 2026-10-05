import "server-only";
import {
  findFindingByScmComment,
  type Database,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import type { RepoRef, ScmAdapter } from "@omniralph/scm";
import { FEEDBACK_REASON_LABELS } from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { enqueueReview } from "@/lib/review/enqueue";
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
}

export type BotCommandOutcome =
  | { status: "refused" }
  | { status: "review_enqueued" | "review_duplicate"; reviewId: string; jobId: string }
  | { status: "review_unavailable" }
  | { status: "dismissed"; findingId: string }
  | { status: "dismiss_conflict"; findingId: string }
  | { status: "reply_enqueued"; jobId: string }
  | { status: "not_in_finding_thread" }
  | { status: "help" };

/** Commands that change state need write access to the repository. */
const PRIVILEGED: ReadonlySet<BotCommand["kind"]> = new Set(["review", "dismiss"]);

/** The command list, in code spans so posting it can't trigger a command. */
function helpText(handle: string): string {
  const cmd = (text: string) => inlineCode(`@${handle} ${text}`);
  return [
    "Here's what I can do:",
    "",
    `- ${cmd("review")}: review the whole diff again (optionally ${cmd("review quick")}, ${cmd("review standard")} or ${cmd("review deep")}).`,
    `- ${cmd("dismiss [reason]")} in one of my finding's threads: dismiss the finding (reasons: false positive, won't fix, not relevant, other).`,
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
 * thread (or the conversation). `review` and `dismiss` need write access to
 * the repository (`ScmAdapter.hasWriteAccess`); others get a polite refusal.
 * Every reply goes through the output sanitizer.
 */
export async function runBotCommand(ctx: BotCommandContext): Promise<BotCommandOutcome> {
  const { db, dispatcher, adapter, repository, connection, comment, command, handle } = ctx;
  const repo: RepoRef = { fullPath: repository.fullPath, externalId: repository.externalId };
  const author = comment.author.username;
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const respond = async (text: string) => {
    const body = sanitizeCapped(
      text,
      { allowedHosts: [new URL(webUrl).hostname], author },
      MAX_BODY_CHARS,
    );
    if (comment.replyTo.kind === "thread") {
      await adapter.replyToComment(repo, comment.number, comment.replyTo.commentId, body);
    } else {
      await adapter.postComment(repo, comment.number, body);
    }
  };

  if (PRIVILEGED.has(command.kind) && !(await adapter.hasWriteAccess(repo, author))) {
    await respond(
      `Sorry @${author}, only people with write access to this repository can use ${inlineCode(`@${handle} ${command.kind}`)}. You can still ask me questions about a finding in its thread.`,
    );
    return { status: "refused" };
  }

  const inThread = () =>
    findFindingByScmComment(db, {
      repositoryId: repository.id,
      prNumber: comment.number,
      commentIds: comment.threadIds,
    });

  switch (command.kind) {
    case "review": {
      const cr = await adapter.getChangeRequest(repo, comment.number);
      const result = await enqueueReview(db, dispatcher, {
        repositoryId: repository.id,
        prNumber: comment.number,
        baseSha: cr.startSha ?? cr.baseSha,
        headSha: cr.headSha,
        title: cr.title,
        description: cr.description,
        author: cr.author,
        trigger: "mention",
        mode: "full",
        profileId: command.profileId,
      });
      const head = inlineCode(cr.headSha.slice(0, 12));
      switch (result.status) {
        case "enqueued": {
          const profile = command.profileId ? `**${PROFILE_NAMES[command.profileId]}** ` : "";
          await respond(
            `On it, @${author}: a full ${profile}review of ${head} is queued. I'll post the results here when it's done.`,
          );
          return { status: "review_enqueued", reviewId: result.reviewId, jobId: result.jobId };
        }
        case "duplicate":
          await respond(`A review of ${head} is already queued or running, @${author}.`);
          return { status: "review_duplicate", reviewId: result.reviewId, jobId: result.jobId };
        case "repository_unavailable":
        case "profile_not_found":
          await respond(
            `Sorry @${author}, I can't review this right now: ${
              result.status === "profile_not_found"
                ? "that review profile doesn't exist."
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
      const learn =
        command.reason === "false_positive"
          ? " I'll learn from it so later reviews don't raise it again."
          : "";
      await respond(`Thanks @${author}, I dismissed this finding (${label}).${learn}`);
      return { status: "dismissed", findingId: found.finding.id };
    }
    case "question": {
      const found = await inThread();
      if (!found) {
        await respond(helpText(handle));
        return { status: "help" };
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
      await respond(`Sorry @${author}, I can't answer questions for this repository right now.`);
      return { status: "review_unavailable" };
    }
    case "help":
      await respond(helpText(handle));
      return { status: "help" };
  }
  throw new Error("unreachable");
}
