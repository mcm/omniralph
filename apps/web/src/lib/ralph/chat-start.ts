/**
 * Starts a request-mode ralph run from a chat thread (the control-panel
 * agent's `start_ralph_request`): the run belongs to the thread, works in the
 * repository the agent named and runs the agent's request as a `ralph.request`
 * job, like a Linear mention. A follow-up in the thread (its last run worked
 * in the same repository) continues that run's branch and PR/MR.
 */
import {
  copyLanes,
  createRun,
  getActiveRunByChatThread,
  getMainLane,
  getRepositoryWithConnection,
  getRunByChatThread,
  listRalphRepositories,
  moveToRepository,
  updateRun,
  type RalphRun,
  type Repository,
} from "@omniralph/db";
import { applyGuidance } from "./messages";
import { errorMessage } from "./notify";
import { addInstruction } from "./requests";
import { advanceRun, chatRunBranch, type RalphDeps } from "./run";

/** How a chat run says it was routed: the agent named the repository. */
export const ROUTED_BY_CHAT = "the chat request";

/** A message of the conversation the request is based on. */
export interface QuotedMessage {
  author: string | null;
  text: string;
}

export interface ChatRequestInput {
  /** The `chat_threads` row the run belongs to. */
  chatThreadId: string;
  /** The repository's full path, as the agent gave it. */
  repository: string;
  /** The agent's self-contained instruction. */
  request: string;
  /** The user messages that triggered it, quoted after the request. */
  quoted: readonly QuotedMessage[];
  /** Who asked (their chat display name). */
  author: string | null;
  /**
   * Ship the previous run's work (`/ship`): the job commits, pushes and opens
   * the PR/MR. Only a follow-up in the same repository has work to ship.
   */
  ship?: boolean;
  /**
   * Posts the handoff message to the thread, once the run exists and before
   * its job is enqueued.
   */
  announce(run: RalphRun, repository: Repository, followUp: boolean): Promise<void>;
}

export type ChatRequestOutcome =
  | { status: "unknown_repository"; candidates: string[] }
  | { status: "already_running"; run: RalphRun }
  | { status: "failed"; error: string }
  /** `ship` without an earlier run of the thread in that repository: there's no branch to ship. */
  | { status: "nothing_to_ship" }
  | { status: "started"; run: RalphRun; repository: Repository; followUp: boolean };

/** Normalizes a repository full path for matching (case, surrounding slashes). */
const normalized = (path: string) =>
  path
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

/** The request text stored for the run: the instruction, then the quoted chat messages. */
export function chatRequestText(request: string, quoted: readonly QuotedMessage[]): string {
  const messages = quoted.filter((m) => m.text.trim());
  if (messages.length === 0) return request.trim();
  const quotes = messages.map((m) => {
    const lines = m.text.trim().replace(/\n/g, "\n> ");
    return m.author ? `> **${m.author}:** ${lines}` : `> ${lines}`;
  });
  return [request.trim(), "From the chat thread:", ...quotes].join("\n\n");
}

/**
 * Starts the thread's run (see the module comment). Refuses when the thread
 * already has an unfinished run, or the repository isn't one of the
 * organization's ralph-enabled repositories.
 */
export async function startChatRequest(
  deps: RalphDeps,
  input: ChatRequestInput,
): Promise<ChatRequestOutcome> {
  const { db } = deps;
  const repositories = await listRalphRepositories(db, deps.organizationId);
  const repository = repositories.find(
    (r) => normalized(r.fullPath) === normalized(input.repository),
  );
  if (!repository) {
    return { status: "unknown_repository", candidates: repositories.map((r) => r.fullPath) };
  }
  const active = await getActiveRunByChatThread(db, input.chatThreadId);
  if (active) return { status: "already_running", run: active };

  // A follow-up continues the thread's last run in the same repository (its branch and PR/MR).
  const last = await getRunByChatThread(db, input.chatThreadId);
  const previous =
    last &&
    last.organizationId === deps.organizationId &&
    last.repositoryId === repository.id &&
    (await getMainLane(db, last))
      ? last
      : null;

  if (input.ship && !previous) return { status: "nothing_to_ship" };

  let baseBranch = "";
  if (!previous) {
    try {
      const found = await getRepositoryWithConnection(db, repository.id);
      if (!found) throw new Error(`repository ${repository.fullPath} is gone`);
      baseBranch = await deps.adapterFor(db, found.connection).getDefaultBranch({
        fullPath: found.repository.fullPath,
        externalId: found.repository.externalId,
      });
    } catch (error) {
      return {
        status: "failed",
        error: `I couldn't read the default branch of ${repository.fullPath}: ${errorMessage(error)}`,
      };
    }
  }

  const { run, created } = await db.transaction(async (tx) => {
    const result = await createRun(tx, {
      origin: "chat",
      organizationId: deps.organizationId,
      chatThreadId: input.chatThreadId,
      // The main lane is the previous run's (copied below) or a new one.
      repositoryId: null,
      routedBy: ROUTED_BY_CHAT,
    });
    if (!result.created) return result;
    let run = result.run;
    if (previous) {
      await copyLanes(tx, previous.id, run.id);
      run =
        (await updateRun(tx, run.id, {
          guidance: previous.guidance,
          progress: previous.progress,
        })) ?? run;
    }
    const moved = await moveToRepository(tx, run.id, repository.id, {
      branch: chatRunBranch(run),
      baseBranch,
    });
    if (!moved) throw new Error(`Ralph run ${run.id} is gone`);
    run = { ...run, repositoryId: repository.id };
    await addInstruction(
      tx,
      run,
      {
        text: chatRequestText(input.request, input.quoted),
        author: input.author,
        wantsLoop: false,
        ...(input.ship && { ship: true }),
        trigger: "chat.request",
      },
      applyGuidance,
    );
    return { run, created: true };
  });
  if (!created) return { status: "already_running", run };

  await input.announce(run, repository, !!previous);
  try {
    await advanceRun(run.id, deps);
  } catch (error) {
    // The request stays pending: the next advance (e.g. the reconcile cron) enqueues it.
    console.error(`Advancing chat ralph run ${run.id} failed`, error);
  }
  return { status: "started", run, repository, followUp: !!previous };
}
