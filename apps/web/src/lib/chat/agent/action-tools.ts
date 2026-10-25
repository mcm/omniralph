import "server-only";
import {
  createChatLinearIssueDraft,
  getRun,
  latestThreadRun,
  lockRun,
  setChatLinearIssueDraftMessage,
  type ChatMessageAttachment,
  type RalphRun,
} from "@omniralph/db";
import { PERMISSION_ALLOW, PERMISSION_DENY } from "@omniralph/ralph";
import { z } from "zod";
import { LinearNotConnectedError } from "@/lib/linear/client";
import type { IssueSummary, Team } from "@/lib/linear/gateway";
import { sendGuidance, sendToChatRun } from "@/lib/ralph/chat-reply";
import { startChatRequest } from "@/lib/ralph/chat-start";
import { answerCleanup } from "@/lib/ralph/cleanup";
import { conversationFor } from "@/lib/ralph/conversation";
import { postActivity } from "@/lib/ralph/notify";
import { answerPermission } from "@/lib/ralph/permissions";
import { runHref } from "@/lib/runs/links";
import { attachmentName, sessionAttachmentNote, type ThreadAttachment } from "../attachments";
import { delegateToRalph, draftCard, LINEAR_ISSUE_DRAFT_TTL_MS } from "../linear-issue";
import { chatTaskOf, findRalphRunId } from "./read-tools";
import {
  defineChatTool,
  LINK_REQUIRED_RESULT,
  type ChatToolContext,
  type ChatToolRegistry,
} from "./tools";

/**
 * `action` tools: what the control-panel agent does for a linked member. A
 * ralph run started here belongs to the thread (`chat_thread_runs`): its
 * answers, questions and end come back to the agent as run events, and the
 * person's answers go back to it through `reply_to_run`,
 * `answer_run_permission` and `answer_run_cleanup`.
 */

const runUrl = (appUrl: string, run: Pick<RalphRun, "id">) => `${appUrl}${runHref(run.id)}`;

export const startWork = defineChatTool({
  tier: "action",
  description:
    "Starts work on a change request: a coding task of this channel's \"start work\" task in one of the organization's repositories with coding on, bound to this thread. It works on its own branch, its answers and questions come back to you as run events for this thread, and opens a pull/merge request when the request calls for one. A follow-up in a thread whose last run worked in the same repository continues that run's branch and pull request. Only call it once the repository is unambiguous. It returns the run's id right away and posts nothing: tell the user in your reply that the run started.",
  inputSchema: z.object({
    repository: z
      .string()
      .min(1)
      .max(300)
      .describe("Full path of a repository with coding on of the organization, e.g. `acme/api`."),
    request: z
      .string()
      .min(1)
      .max(10_000)
      .describe(
        "The self-contained instruction for the coding agent: what to change, where and why, with every detail from the conversation it needs (it doesn't read the thread). The users' messages are quoted after it.",
      ),
    ship: z
      .boolean()
      .optional()
      .describe(
        'True when the user asks to ship the work of this thread\'s last run in that repository ("ship it", commit and push it, open the PR): Omniralph then commits what it left, pushes the branch and opens the pull/merge request. `request` may add last notes (e.g. "bump the version first"), or just say to ship it.',
      ),
  }),
  async execute(input, context: ChatToolContext) {
    const { chatThread, appUrl } = context;
    const task = await chatTaskOf(context, "startWork");
    if ("error" in task) return task;
    const outcome = await startChatRequest(await context.ralph(), {
      chatThreadId: chatThread.id,
      repository: input.repository,
      request: input.request,
      quoted: context.turnMessages,
      author: context.turnMessages.at(-1)?.author ?? null,
      ...(input.ship && { ship: true }),
      codingTaskId: task.task.id,
    });
    switch (outcome.status) {
      case "unknown_repository":
        return {
          error: "unknown_repository",
          message:
            outcome.candidates.length > 0
              ? `\`${input.repository}\` isn't a repository of this organization with coding on. Ask the user which of these they mean: ${outcome.candidates.join(", ")}.`
              : "No repository of this organization has coding on. An admin can turn it on under Repository › Settings › Task types in the control panel.",
          candidates: outcome.candidates,
        };
      case "already_running":
        return {
          error: "run_active",
          message:
            "This thread already has a coding task in progress. Don't start another one: pass the user's request to that run with reply_to_run instead.",
          run: { id: outcome.run.id, status: outcome.run.status, url: runUrl(appUrl, outcome.run) },
        };
      case "failed":
        return { error: "start_failed", message: outcome.error };
      case "nothing_to_ship":
        return {
          error: "nothing_to_ship",
          message: `This thread has no earlier coding task in \`${input.repository}\`, so there's no branch to ship. Tell the user, or start the change itself without \`ship\`.`,
        };
      case "started":
        return {
          status: "started",
          runId: outcome.run.id,
          url: runUrl(appUrl, outcome.run),
          task: task.task.id,
          repository: outcome.repository.fullPath,
          followUp: outcome.followUp,
          message: outcome.followUp
            ? "The run started, continuing the previous run's branch and pull request; its answers, questions and end come back to you as run events. Tell the user in your reply that it started (with the run's link and a one-sentence summary of the request)."
            : "The run started; its answers, questions and end come back to you as run events. Tell the user in your reply that it started (with the run's link and a one-sentence summary of the request).",
        };
    }
  },
});

/** Most attached files a reply to the thread's run includes. */
const MAX_RUN_REPLY_ATTACHMENTS = 5;

/**
 * The thread's latest coding run, found through its mapping
 * (`chat_thread_runs`) for this thread and the connection's organization, or
 * null.
 */
async function threadCodingRun(context: ChatToolContext): Promise<RalphRun | null> {
  const { db, organizationId, chatThread } = context;
  const mapping = await latestThreadRun(db, organizationId, chatThread.id, "coding");
  if (!mapping?.ralphRunId) return null;
  const run = await getRun(db, mapping.ralphRunId);
  return run?.organizationId === organizationId ? run : null;
}

/** The author an answer is passed on as: the member, else the message's author. */
const answerAuthor = (context: ChatToolContext) =>
  (context.actor.kind === "member" ? context.actor.name : null) ??
  context.turnMessages.at(-1)?.author ??
  null;

/** The note on the thread's attachments with these refs for the run's session (an error result for an unknown ref). */
async function runReplyAttachments(
  context: ChatToolContext,
  refs: readonly string[],
): Promise<{ note: string | null } | { error: "unknown_attachment"; message: string }> {
  const known = [...(context.attachments?.values() ?? [])];
  const files: ThreadAttachment[] = [];
  for (const ref of new Set(refs.map((r) => r.trim()))) {
    const attachment = context.attachments?.get(ref);
    if (!attachment) {
      return {
        error: "unknown_attachment",
        message:
          known.length > 0
            ? `"${ref}" isn't a file attached in this thread. The thread's attachments: ${known.map((a) => `${a.ref} (${attachmentName(a.meta)})`).join(", ")}.`
            : "No files are attached in this thread: reply without attachments.",
      };
    }
    files.push(attachment);
  }
  // Reuses what the turn fetched already.
  const note = await sessionAttachmentNote(
    files.map((f) => f.meta),
    async (meta) => {
      const content = await files.find((f) => f.meta === meta)!.load();
      if (content.status !== "loaded") throw new Error(content.reason);
      return content.data;
    },
  );
  return { note };
}

export const replyToRun = defineChatTool({
  tier: "action",
  description:
    "Passes a message to this thread's coding run (one started with start_work), as if the user had replied to its session: while its session works, its agent gets the message right away (`live`); otherwise it runs as the run's next request once the current step finishes (`queued`). Use it for an answer to a question the run asked in the thread, or when a user wants to steer the run (more detail, a correction, a question for it). Its answer comes back to you as a run event. Not for approval requests (answer_run_permission) or cleanup questions (answer_run_cleanup).",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(10_000)
      .describe(
        "The message for the run: self-contained, with what the user said (quote them when it helps).",
      ),
    ship: z
      .boolean()
      .optional()
      .describe(
        'True when the user asks to ship the run\'s work ("ship it", commit and push it, open the PR): after its current step, Omniralph commits the work, pushes the branch and opens the pull/merge request. `text` may add last notes.',
      ),
    attachments: z
      .array(z.string().min(1).max(40))
      .max(MAX_RUN_REPLY_ATTACHMENTS)
      .optional()
      .describe(
        "Refs of files attached in the thread (`[attachment <ref>: …]`) the run should get with the message, e.g. a pasted log. It gets text files' content; it can't see images, so describe what a screenshot shows in `text`.",
      ),
  }),
  async execute(input, context: ChatToolContext) {
    const { db, organizationId, chatThread, appUrl } = context;
    const latest = await latestThreadRun(db, organizationId, chatThread.id);
    if (latest?.kind === "query") {
      return {
        error: "query_run",
        message:
          "This thread's latest run answered a code question, and those take no replies. For a follow-up question about the code, call ask_about_code again: it gets the previous question and its answer.",
      };
    }
    const attachments = await runReplyAttachments(context, input.attachments ?? []);
    if ("error" in attachments) return attachments;
    const outcome = await sendToChatRun(await context.ralph(), {
      chatThreadId: chatThread.id,
      text: input.text,
      author: answerAuthor(context),
      attachments: attachments.note,
      ...(input.ship && { ship: true }),
    });
    switch (outcome.status) {
      case "no_run":
        return {
          error: "no_active_run",
          message:
            "This thread has no coding run in progress. To have Omniralph do more, start new work with start_work.",
        };
      case "live":
        return {
          status: "live",
          run: { id: outcome.run.id, url: runUrl(appUrl, outcome.run) },
          message:
            "Passed to the session that is working right now; its answer comes back to you as a run event. Tell the user briefly.",
        };
      case "queued":
        return {
          status: "queued",
          run: { id: outcome.run.id, url: runUrl(appUrl, outcome.run) },
          message:
            "The run takes this as its next request once its current step finishes; its answer comes back to you as a run event. Tell the user briefly.",
        };
    }
  },
});

export const answerRunPermission = defineChatTool({
  tier: "action",
  description:
    "Answers the open approval request (`permission_request`) of this thread's coding run: allows or denies the tool call its session asked about. Use it when a member answers the request relayed in the thread (yes/approve/go ahead, or no/deny), in any wording. Only call it when the member's answer is clear; ask them otherwise.",
  inputSchema: z.object({
    allow: z.boolean().describe("True to allow the tool call, false to deny it."),
  }),
  async execute(input, context: ChatToolContext) {
    const { db, appUrl } = context;
    const run = await threadCodingRun(context);
    const asked = run?.permission;
    if (!run || !asked) {
      return {
        error: "no_question",
        message: "This thread's run has no approval request. Tell the user nothing was waiting.",
      };
    }
    const ralph = await context.ralph();
    const note = asked.answer
      ? null
      : await lockRun(db, run.id, async (tx, current) =>
          current.permission?.requestId === asked.requestId
            ? answerPermission(
                tx,
                db,
                current,
                input.allow ? PERMISSION_ALLOW : PERMISSION_DENY,
                answerAuthor(context) ?? undefined,
              )
            : null,
        );
    const answered = (await getRun(db, run.id))?.permission;
    if (
      !note ||
      answered?.requestId !== asked.requestId ||
      (answered.answer !== "allowed" && answered.answer !== "denied")
    ) {
      return {
        error: "not_open",
        message: `The approval request about ${asked.tool} isn't open anymore (it expired, was answered already, or the session that asked ended), so the answer did nothing. Tell the user.`,
      };
    }
    await postActivity(conversationFor(run, ralph), note, {
      notice: true,
      event: { kind: "response", key: `permission:${asked.requestId}:answer` },
    });
    return {
      status: "answered",
      answer: answered.answer,
      tool: asked.tool,
      run: { id: run.id, url: runUrl(appUrl, run) },
      message:
        "The session got the answer and carries on. Tell the user briefly, or end your turn with no text.",
    };
  },
});

export const answerRunCleanup = defineChatTool({
  tier: "action",
  description:
    "Answers a cleanup question (`cleanup_question`) of this thread's coding run, asked after its pull/merge request merged: what to do with a branch's unmerged commits or leftover stashes. Pass the member's answer; it must name one of the options the question listed (or its number).",
  inputSchema: z.object({
    answer: z
      .string()
      .min(1)
      .max(1_000)
      .describe("The member's answer: one of the options the question offered, as they said it."),
  }),
  async execute(input, context: ChatToolContext) {
    const run = await threadCodingRun(context);
    const outcome = run ? await answerCleanup(await context.ralph(), run.id, input.answer) : null;
    if (!run || !outcome) {
      return {
        error: "no_match",
        message: run
          ? "That answer doesn't match an open cleanup question of this thread's run. Ask the user to pick one of the options the question listed."
          : "This thread has no coding run with a cleanup question.",
      };
    }
    const result = { status: outcome.status, option: outcome.option };
    switch (outcome.status) {
      case "enqueued":
        return {
          ...result,
          message:
            "The run carries out the answer now and reports back as a run event. Tell the user briefly.",
        };
      case "busy":
        return {
          ...result,
          message:
            "The run is still carrying out the previous answer about this branch (the thread is told). Ask the user to answer again once it's done.",
        };
      case "failed":
        return { ...result, error: outcome.error, message: "Carrying out the answer failed." };
    }
  },
});

export const sendRalphGuidance = defineChatTool({
  tier: "action",
  description:
    "Sends guidance to any unfinished coding task of the organization, also one started from Linear (look it up with list_ralph_runs / get_ralph_run first): it applies it from its next story attempt (epic runs) or handles it as its next request, once the job it is running finishes. A Linear run's session shows it too. For the coding task of this thread, prefer reply_to_run, which reaches a working session right away.",
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
          message: `No coding task of this organization matches "${ref}".`,
        };
      case "finished":
        return {
          error: "run_finished",
          message: `That run is ${outcome.run.status}, so it takes no more guidance. A Linear run starts again when its issue is delegated to Omniralph again; for a change in a repository, start new work with start_work.`,
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

export const LINEAR_NOT_CONNECTED_RESULT = {
  error: "linear_not_connected",
  message:
    "This organization has no Linear workspace connected, so you can't create Linear issues. Tell the user an admin can connect one under Settings › Integrations in the control panel.",
} as const;

/** The team `ref` names (key, name or ID, ignoring case), or undefined. */
export function findTeam(teams: readonly Team[], ref: string): Team | undefined {
  const wanted = ref.trim().toLowerCase();
  return teams.find(
    (t) => t.key.toLowerCase() === wanted || t.name.toLowerCase() === wanted || t.id === ref.trim(),
  );
}

/** Most screenshots an issue drafted in chat embeds. */
export const MAX_ISSUE_SCREENSHOTS = 5;

/** The thread's images with these refs, for a draft (an error result for any other ref). */
function issueScreenshots(
  context: ChatToolContext,
  refs: readonly string[],
):
  | { attachments: Array<ChatMessageAttachment & { ref: string }> }
  | { error: "unknown_attachment"; message: string } {
  const images = [...(context.attachments?.values() ?? [])].filter((a) => a.kind === "image");
  const attachments: Array<ChatMessageAttachment & { ref: string }> = [];
  for (const ref of new Set(refs.map((r) => r.trim()))) {
    const image = images.find((a) => a.ref === ref);
    if (!image) {
      return {
        error: "unknown_attachment",
        message:
          images.length > 0
            ? `"${ref}" isn't an image attached in this thread. The thread's images: ${images.map((a) => `${a.ref} (${attachmentName(a.meta)})`).join(", ")}.`
            : "No images are attached in this thread: draft the issue without attachments.",
      };
    }
    attachments.push({ ...image.meta, ref });
  }
  return { attachments };
}

export const draftLinearIssue = defineChatTool({
  tier: "action",
  description:
    "Drafts a Linear issue in the organization's Linear workspace from the conversation: posts a preview card in the thread with Create and Cancel buttons. Nothing is created until the user who asked clicks Create (within 24 hours); then the card shows the issue's identifier and link. Use it when a user asks you to file, open or create an issue/ticket. Write a self-contained title and description (the problem, context and acceptance criteria from the thread, in Markdown). Ask which team when the user hasn't said and the workspace has several. Pass the refs of relevant screenshots attached in the thread as `attachments`: the card lists them, and they are uploaded and embedded in the issue on Create.",
  inputSchema: z.object({
    team: z.string().min(1).max(200).describe("The Linear team: its key (e.g. `ENG`), name or ID."),
    title: z.string().min(1).max(255).describe("A short, specific issue title."),
    description: z
      .string()
      .max(20_000)
      .describe(
        "The issue description in Markdown, self-contained (Linear readers don't see the thread).",
      ),
    project: z.string().min(1).max(200).optional().describe("A Linear project name to add it to."),
    labels: z
      .array(z.string().min(1).max(80))
      .max(10)
      .optional()
      .describe("Label names; a label the team doesn't have yet is created."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe("Linear priority: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low."),
    attachments: z
      .array(z.string().min(1).max(40))
      .max(MAX_ISSUE_SCREENSHOTS)
      .optional()
      .describe(
        "Refs of images attached in the thread (`[attachment <ref>: …]`), e.g. screenshots of the bug, to upload to Linear and embed in the description. Only when they are relevant.",
      ),
  }),
  async execute(input, context: ChatToolContext) {
    const { db, actor, thread, chatThread } = context;
    if (actor.kind !== "member") return LINK_REQUIRED_RESULT;
    const screenshots = issueScreenshots(context, input.attachments ?? []);
    if ("error" in screenshots) return screenshots;
    let teams: Team[];
    try {
      teams = await (await context.ralph()).linear.listTeams();
    } catch (error) {
      if (error instanceof LinearNotConnectedError) return LINEAR_NOT_CONNECTED_RESULT;
      return {
        error: "linear_error",
        message: `Linear couldn't list the workspace's teams: ${error instanceof Error ? error.message : String(error)}. Tell the user to try again later.`,
      };
    }
    const team = findTeam(teams, input.team);
    if (!team) {
      return {
        error: "unknown_team",
        message:
          teams.length > 0
            ? `The Linear workspace has no team "${input.team}". Ask the user which of these they mean: ${teams.map((t) => `${t.key} (${t.name})`).join(", ")}.`
            : "The Linear workspace has no teams.",
        teams: teams.map((t) => ({ key: t.key, name: t.name })),
      };
    }
    const draft = await createChatLinearIssueDraft(db, {
      threadId: chatThread.id,
      requestedByUserId: actor.userId,
      requestedByExternalUserId: context.requesterExternalUserId,
      teamId: team.id,
      teamKey: team.key,
      title: input.title.trim(),
      description: input.description.trim(),
      projectName: input.project?.trim() || null,
      labels: input.labels?.map((l) => l.trim()).filter(Boolean) ?? [],
      priority: input.priority ?? null,
      attachments: screenshots.attachments,
      expiresAt: new Date(Date.now() + LINEAR_ISSUE_DRAFT_TTL_MS),
    });
    const posted = await thread.post(draftCard(draft));
    await setChatLinearIssueDraftMessage(db, draft.id, posted.id);
    context.handedOff();
    return {
      status: "drafted",
      draft: {
        id: draft.id,
        team: team.key,
        title: draft.title,
        screenshots: draft.attachments.map((a) => attachmentName(a)),
      },
      message:
        "The preview card with Create and Cancel buttons is posted in the thread; nothing is created until the user clicks Create (within 24 hours). Don't repeat the preview: end your turn with no text, or one short line.",
    };
  },
});

const linearErrorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const delegateLinearIssue = defineChatTool({
  tier: "action",
  description:
    "Delegates an existing Linear issue to the Omniralph app, so Omniralph builds it (an epic with a PRD and stories, or a single issue) the way it does when someone delegates it in Linear. Omniralph works in the issue's Linear agent session; this thread gets a message when the run starts, when it opens its pull/merge request, and when it finishes or fails. Use it when a user asks to have Omniralph build, work on or take an existing issue. For a new issue, draft it with draft_linear_issue instead: its card has a Create and delegate button.",
  inputSchema: z.object({
    issue: z
      .string()
      .min(1)
      .max(100)
      .describe("The Linear issue identifier (e.g. `ENG-42`) or ID."),
  }),
  async execute(input, context: ChatToolContext) {
    const { db, actor, chatThread, organizationId } = context;
    if (actor.kind !== "member") return LINK_REQUIRED_RESULT;
    const ref = input.issue.trim();
    let issue: IssueSummary;
    try {
      const { linear } = await context.ralph();
      try {
        issue = await linear.getIssue(ref);
      } catch (error) {
        if (error instanceof LinearNotConnectedError) throw error;
        return {
          error: "unknown_issue",
          message: `Linear couldn't find the issue "${ref}" (${linearErrorText(error)}). Ask the user for the issue's identifier, e.g. ENG-42.`,
        };
      }
      await delegateToRalph(db, linear, {
        organizationId,
        chatThreadId: chatThread.id,
        linearIssueId: issue.id,
      });
    } catch (error) {
      if (error instanceof LinearNotConnectedError) return LINEAR_NOT_CONNECTED_RESULT;
      return {
        error: "linear_error",
        message: `Linear didn't delegate the issue: ${linearErrorText(error)}. Tell the user to try again later, or to delegate it to Omniralph in Linear.`,
      };
    }
    return {
      status: "delegated",
      issue: { identifier: issue.identifier, title: issue.title, url: issue.url },
      message:
        "Delegated to Omniralph. Tell the user briefly, with the issue's link; this thread gets a message when the run starts and when it finishes.",
    };
  },
});

export const actionTools: ChatToolRegistry = {
  start_work: startWork,
  reply_to_run: replyToRun,
  answer_run_permission: answerRunPermission,
  answer_run_cleanup: answerRunCleanup,
  send_ralph_guidance: sendRalphGuidance,
  draft_linear_issue: draftLinearIssue,
  delegate_linear_issue: delegateLinearIssue,
};
