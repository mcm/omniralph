import "server-only";
import {
  createChatLinearIssueDraft,
  setChatLinearIssueDraftMessage,
  type ChatMessageAttachment,
  type RalphRun,
} from "@omniralph/db";
import { z } from "zod";
import { LinearNotConnectedError } from "@/lib/linear/client";
import type { IssueSummary, Team } from "@/lib/linear/gateway";
import { sendGuidance, sendToChatRun } from "@/lib/ralph/chat-reply";
import { startChatRequest } from "@/lib/ralph/chat-start";
import { attachmentName } from "../attachments";
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
 * progress and answer are posted in it (`ChatConversation`).
 */

const runUrl = (appUrl: string, run: Pick<RalphRun, "id">) => `${appUrl}/ralph/${run.id}`;

export const startWork = defineChatTool({
  tier: "action",
  description:
    "Starts work on a change request: a ralph run of this channel's \"start work\" coding task in one of the organization's ralph-enabled repositories, bound to this thread. Ralph works on its own branch, reports its progress and answer in this thread, and opens a pull/merge request when the request calls for one. A follow-up in a thread whose last run worked in the same repository continues that run's branch and pull request. Only call it once the repository is unambiguous. It returns the run's id right away and posts nothing: tell the user in your reply that the run started.",
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
    ship: z
      .boolean()
      .optional()
      .describe(
        'True when the user asks to ship the work of this thread\'s last run in that repository ("ship it", commit and push it, open the PR): ralph then commits what it left, pushes the branch and opens the pull/merge request. `request` may add last notes (e.g. "bump the version first"), or just say to ship it.',
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
      case "nothing_to_ship":
        return {
          error: "nothing_to_ship",
          message: `This thread has no earlier ralph run in \`${input.repository}\`, so there's no branch to ship. Tell the user, or start the change itself without \`ship\`.`,
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
            ? "The run started, continuing the previous run's branch and pull request; ralph reports its progress and answer in this thread. Tell the user in your reply that it started (with the run's link and a one-sentence summary of the request)."
            : "The run started; ralph reports its progress and answer in this thread. Tell the user in your reply that it started (with the run's link and a one-sentence summary of the request).",
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
    ship: z
      .boolean()
      .optional()
      .describe(
        'True when the user asks to ship the run\'s work ("ship it", commit and push it, open the PR): after its current step, ralph commits the work, pushes the branch and opens the pull/merge request. `text` may add last notes.',
      ),
  }),
  async execute(input, context: ChatToolContext) {
    const outcome = await sendToChatRun(await context.ralph(), {
      chatThreadId: context.chatThread.id,
      text: input.text,
      author: context.turnMessages.at(-1)?.author ?? null,
      ...(input.ship && { ship: true }),
    });
    switch (outcome.status) {
      case "no_run":
        return {
          error: "no_active_run",
          message:
            "This thread has no ralph run in progress. To have ralph do more, start new work with start_work.",
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
    "Delegates an existing Linear issue to the Omniralph app, so ralph builds it (an epic with a PRD and stories, or a single issue) the way it does when someone delegates it in Linear. Ralph works in the issue's Linear agent session; this thread gets a message when the run starts, when it opens its pull/merge request, and when it finishes or fails. Use it when a user asks to have ralph build, work on or take an existing issue. For a new issue, draft it with draft_linear_issue instead: its card has a Create and delegate button.",
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
        "Delegated to ralph. Tell the user briefly, with the issue's link; this thread gets a message when the run starts and when it finishes.",
    };
  },
});

export const actionTools: ChatToolRegistry = {
  start_work: startWork,
  send_to_session: sendToSession,
  send_ralph_guidance: sendRalphGuidance,
  draft_linear_issue: draftLinearIssue,
  delegate_linear_issue: delegateLinearIssue,
};
