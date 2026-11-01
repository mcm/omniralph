/**
 * Notifications for a Linear run delegated from a chat thread (`origin`
 * `linear` with a `chat_thread_id`): the run talks in its Linear agent
 * session as usual, and the thread only hears that it started, opened its
 * PR/MR, completed or failed, one message each, with links. Nothing else is
 * mirrored. Best effort: a failure is logged, never fails the run.
 */
import { appendChatMessage, type RalphRun } from "@omniralph/db";
import { MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import { defaultChatChannel, loadChatTarget, type ChatSource } from "./conversation";
import { errorMessage, tail } from "./notify";
import { withPullRequestLinks, type PublishedLane } from "./publish";

export type RunThreadNotice =
  | { kind: "started" }
  | { kind: "pr_opened"; label: string; url: string }
  | { kind: "completed"; lanes: readonly PublishedLane[] }
  | { kind: "failed"; error: string };

/** The run fields a notification needs. */
export type NotifiedRun = Pick<
  RalphRun,
  | "id"
  | "organizationId"
  | "origin"
  | "chatThreadId"
  | "repositoryId"
  | "trackerIdentifier"
  | "trackerTitle"
  | "trackerUrl"
>;

/** How long a sent notification is remembered (so a repeat isn't posted again). */
const NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How much of a failure the thread is told. */
const MAX_ERROR_CHARS = 1_000;

/** Whether the run is a Linear run whose chat thread gets notifications. */
export function notifiesThread(run: Pick<RalphRun, "origin" | "chatThreadId">): boolean {
  return run.origin === "tracker" && run.chatThreadId !== null;
}

/** The issue as a Markdown link (just its identifier without a URL). */
function issueLink(run: NotifiedRun): string {
  const identifier = run.trackerIdentifier ?? "the issue";
  const title = run.trackerTitle ? ` ${run.trackerTitle}` : "";
  return run.trackerUrl ? `[${identifier}${title}](${run.trackerUrl})` : `${identifier}${title}`;
}

/** The message posted for a notice. */
export function noticeText(run: NotifiedRun, notice: RunThreadNotice): string {
  const issue = issueLink(run);
  switch (notice.kind) {
    case "started":
      return `🚀 Omniralph started building ${issue}. Its progress is in the Linear issue; I'll post here when it opens a pull/merge request and when it finishes.`;
    case "pr_opened":
      return `🔗 ${notice.label} for ${issue} is open: ${notice.url}`;
    case "completed":
      return withPullRequestLinks(`✅ Omniralph finished ${issue}.`, notice.lanes);
    case "failed":
      return `⚠️ Omniralph stopped working on ${issue}: ${tail(notice.error, MAX_ERROR_CHARS)}`;
  }
}

/** Identifies a notice, so each is posted once per run. */
function noticeKey(run: Pick<RalphRun, "id">, notice: RunThreadNotice): string {
  const what = notice.kind === "pr_opened" ? `pr:${notice.url}` : notice.kind;
  return `ralph-thread-notice:${run.id}:${what}`;
}

/**
 * Posts a notice to the thread that delegated a Linear run (once per run and
 * notice; once per URL for PRs/MRs). Does nothing for other runs, or when the
 * thread or its connection is gone. Returns whether a message was posted.
 */
export async function notifyRunThread(
  deps: { chat?: ChatSource },
  run: NotifiedRun,
  notice: RunThreadNotice,
): Promise<boolean> {
  if (!notifiesThread(run)) return false;
  try {
    const target = await loadChatTarget(deps.chat ?? defaultChatChannel, run);
    if (!target) {
      console.warn(
        `Skipping the ${notice.kind} notice of ralph run ${run.id}: its chat thread or connection is gone`,
      );
      return false;
    }
    const { state, db } = target.channel;
    const key = noticeKey(run, notice);
    if (!(await state.setIfNotExists(key, true, NOTICE_TTL_MS))) return false;
    const allowedHosts = [...target.allowedHosts];
    if (run.trackerUrl) allowedHosts.push(new URL(run.trackerUrl).hostname);
    const markdown = sanitizeCapped(noticeText(run, notice), { allowedHosts }, MAX_BODY_CHARS);
    try {
      await target.send(() =>
        target.adapter.postMessage(target.thread.externalThreadId, { markdown }),
      );
    } catch (error) {
      // Not posted: a later attempt may post it.
      await state.delete(key);
      throw error;
    }
    await appendChatMessage(db, {
      threadId: target.thread.id,
      role: "assistant",
      content: markdown,
      ralphRunId: run.id,
    });
    return true;
  } catch (error) {
    console.warn(
      `Posting the ${notice.kind} notice of ralph run ${run.id} to its chat thread failed: ${errorMessage(error)}`,
    );
    return false;
  }
}
