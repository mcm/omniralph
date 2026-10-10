import "server-only";
import { appendChatMessage, type RalphRun, type Repository } from "@omniralph/db";
import { z } from "zod";
import { sendGuidance, sendToChatRun } from "@/lib/ralph/chat-reply";
import { startChatRequest } from "@/lib/ralph/chat-start";
import { MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import { findRalphRunId } from "./read-tools";
import { defineChatTool, type ChatToolContext, type ChatToolRegistry } from "./tools";

/**
 * `action` tools: what the control-panel agent does for a linked member. A
 * ralph run started here belongs to the thread: its progress and answer are
 * posted in it (`ChatConversation`).
 */

/** Longest summary of the request the handoff message quotes. */
const MAX_HANDOFF_SUMMARY_CHARS = 300;

/** The first sentence (or line) of a request: the agent's summary of what it hands off. */
export function requestSummary(request: string): string {
  const line = request.trim().split("\n")[0]?.trim() ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  return sentence.length > MAX_HANDOFF_SUMMARY_CHARS
    ? `${sentence.slice(0, MAX_HANDOFF_SUMMARY_CHARS - 1)}…`
    : sentence;
}

/** The message handing the thread to a new run, posted before its job is enqueued. */
export function handoffMessage(input: {
  repository: Pick<Repository, "fullPath">;
  request: string;
  followUp: boolean;
  runUrl: string;
}): string {
  const where = `\`${input.repository.fullPath}\``;
  const lines = [
    input.followUp
      ? `Handing this to ralph in ${where}, continuing the previous run's branch and pull request…`
      : `Handing this to ralph in ${where}…`,
  ];
  const summary = requestSummary(input.request);
  if (summary) lines.push(`> ${summary}`);
  lines.push(`Its progress and answer will follow here ([run](${input.runUrl})).`);
  return lines.join("\n\n");
}

const runUrl = (appUrl: string, run: Pick<RalphRun, "id">) => `${appUrl}/ralph/${run.id}`;

export const startRalphRequest = defineChatTool({
  tier: "action",
  description:
    "Hands a change request to ralph, Omniralph's coding agent: starts a ralph run in one of the organization's ralph-enabled repositories, bound to this thread. Ralph works on its own branch, posts its progress and its answer in this thread, and opens a pull/merge request when the request calls for one. A follow-up in a thread whose last run worked in the same repository continues that run's branch and pull request. Only call it once the repository is unambiguous and you have told the user what you are handing off. It posts the handoff message itself.",
  inputSchema: z.object({
    repository: z
      .string()
      .min(1)
      .max(300)
      .describe("Full path of a ralph-enabled repository of the organization, e.g. `acme/api`."),
    request: z
      .string()
      .min(1)
      .max(10_000)
      .describe(
        "The self-contained instruction for ralph: what to change, where and why, with every detail from the conversation it needs (ralph doesn't read the thread). The users' messages are quoted after it.",
      ),
  }),
  async execute(input, context: ChatToolContext) {
    const { db, thread, chatThread, appUrl } = context;
    const outcome = await startChatRequest(await context.ralph(), {
      chatThreadId: chatThread.id,
      repository: input.repository,
      request: input.request,
      quoted: context.turnMessages,
      author: context.turnMessages.at(-1)?.author ?? null,
      async announce(run, repository, followUp) {
        // The summary is the model's: sanitized like its answers.
        const text = sanitizeCapped(
          handoffMessage({
            repository,
            request: input.request,
            followUp,
            runUrl: runUrl(appUrl, run),
          }),
          { allowedHosts: [new URL(appUrl).host] },
          MAX_BODY_CHARS,
        );
        await thread.post({ markdown: text });
        await appendChatMessage(db, {
          threadId: chatThread.id,
          role: "assistant",
          content: text,
          ralphRunId: run.id,
        });
        context.handedOff();
      },
    });
    switch (outcome.status) {
      case "unknown_repository":
        return {
          error: "unknown_repository",
          message:
            outcome.candidates.length > 0
              ? `\`${input.repository}\` isn't a ralph-enabled repository of this organization. Ask the user which of these they mean: ${outcome.candidates.join(", ")}.`
              : "No repository of this organization has ralph enabled. An admin can enable it under Repository › Settings › Ralph in the control panel.",
          candidates: outcome.candidates,
        };
      case "already_running":
        return {
          error: "run_active",
          message:
            "This thread already has a ralph run in progress. Don't start another one: pass the user's request to that run with send_to_session instead.",
          run: { id: outcome.run.id, status: outcome.run.status, url: runUrl(appUrl, outcome.run) },
        };
      case "failed":
        return { error: "start_failed", message: outcome.error };
      case "started":
        return {
          status: "started",
          run: { id: outcome.run.id, url: runUrl(appUrl, outcome.run) },
          repository: outcome.repository.fullPath,
          followUp: outcome.followUp,
          message:
            "The handoff message is posted in the thread, and ralph will post its progress and answer there. Don't repeat it: end your turn with no text unless you have something else to say.",
        };
    }
  },
});

export const sendToSession = defineChatTool({
  tier: "action",
  description:
    "Passes a message to the ralph run of this thread, as if the user had replied to its session: while it works, its agent gets the message right away; otherwise it runs as the run's next request once the current step finishes. Use it when a user mentions you to steer the running session (more detail, a correction, a question for it). It answers in this thread itself.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(10_000)
      .describe(
        "The message for the session: self-contained, with what the user asked for (quote them when it helps).",
      ),
  }),
  async execute(input, context: ChatToolContext) {
    const outcome = await sendToChatRun(await context.ralph(), {
      chatThreadId: context.chatThread.id,
      text: input.text,
      author: context.turnMessages.at(-1)?.author ?? null,
    });
    switch (outcome.status) {
      case "no_run":
        return {
          error: "no_active_run",
          message:
            "This thread has no ralph run in progress. To have ralph do more, hand it a new request with start_ralph_request.",
        };
      case "live":
        return {
          status: "delivered",
          run: { id: outcome.run.id, url: runUrl(context.appUrl, outcome.run) },
          message:
            "Passed to the session that is working right now; it answers in this thread. Tell the user briefly.",
        };
      case "queued":
        return {
          status: "queued",
          run: { id: outcome.run.id, url: runUrl(context.appUrl, outcome.run) },
          message:
            "The run takes this as its next request once its current step finishes, and answers in this thread. Tell the user briefly.",
        };
      case "answered":
        return {
          status: "answered",
          run: { id: outcome.run.id, url: runUrl(context.appUrl, outcome.run) },
          message:
            "That answered the session's open permission question; the answer is posted in the thread. End your turn with no text.",
        };
    }
  },
});

export const sendRalphGuidance = defineChatTool({
  tier: "action",
  description:
    "Sends guidance to any unfinished ralph run of the organization, also one started from Linear (look it up with list_ralph_runs / get_ralph_run first): ralph applies it from its next story attempt (epic runs) or handles it as its next request, once the job it is running finishes. A Linear run's session shows it too. For the ralph run of this thread, prefer send_to_session, which reaches a working session right away.",
  inputSchema: z.object({
    run: z.string().min(1).max(100).describe("Run id or Linear issue identifier (e.g. `ENG-42`)."),
    text: z
      .string()
      .min(1)
      .max(10_000)
      .describe(
        "The guidance: self-contained, with what the user asked for (quote them when it helps).",
      ),
  }),
  async execute(input, context: ChatToolContext) {
    const { db, organizationId, appUrl, actor } = context;
    const ref = input.run.trim();
    const runId = await findRalphRunId(db, organizationId, ref);
    const author =
      (actor.kind === "member" ? actor.name : null) ?? context.turnMessages.at(-1)?.author ?? null;
    const outcome = runId
      ? await sendGuidance(await context.ralph(), { runId, text: input.text, author })
      : ({ status: "not_found" } as const);
    switch (outcome.status) {
      case "not_found":
        return {
          error: "not_found",
          message: `No ralph run of this organization matches "${ref}".`,
        };
      case "finished":
        return {
          error: "run_finished",
          message: `That run is ${outcome.run.status}, so it takes no more guidance. A Linear run starts again when its issue is delegated to Omniralph again; for a change in a repository, hand ralph a new request with start_ralph_request.`,
          run: { id: outcome.run.id, status: outcome.run.status, url: runUrl(appUrl, outcome.run) },
        };
      case "applied":
        return {
          status: "applied",
          run: { id: outcome.run.id, status: outcome.run.status, url: runUrl(appUrl, outcome.run) },
          message: outcome.busy
            ? "Stored: the run applies it once the job it is running finishes. Tell the user briefly."
            : "Stored: the run applies it from its next step. Tell the user briefly.",
        };
    }
  },
});

export const actionTools: ChatToolRegistry = {
  start_ralph_request: startRalphRequest,
  send_to_session: sendToSession,
  send_ralph_guidance: sendRalphGuidance,
};
