/**
 * Requests from the Linear thread (ported from cyralph's request mode:
 * `parseInstruction`, `onCreated`, `runRequestOnly`, `runRequests` and
 * `adoptPullRequests`). A request is a `ralph_messages` row of kind `request`
 * without a job (`listPendingRequests`), for a lane (null: the main lane).
 *
 * - A mention runs in request mode: its requests run as `ralph.request` jobs
 *   (one Claude session per lane, main lane first), with no story loop, no
 *   Linear state changes and no blockers; then the run completes with what
 *   they said. `/ralph` switches the run to epic mode.
 * - In epic mode, a reply is guidance and a pending request: the next story
 *   takes it (as guidance), and when no story runs (the epic is done, or
 *   waits on blockers) it runs as a request. Push/PR requests never go to a
 *   story agent: they wait for that.
 *
 * The job returns what the session did and the PR/MR change it asks for
 * (`pullRequest`), which the control panel makes with the SCM adapter and
 * the sanitizer (`applyRequestJob`); agents never hold code-host tokens.
 */
import {
  appendGuidance,
  consumeMessages,
  getJob,
  getRepositoryWithConnection,
  listLanes,
  listPendingRequests,
  updateLane,
  updateRun,
  insertMessage,
  isLinearRun,
  type Job,
  type RalphLane,
  type RalphMessage,
  type RalphRun,
  type RalphTransaction,
} from "@omniralph/db";
import { asksForPushOrPullRequest } from "@omniralph/ralph";
import {
  RalphRequestPayload,
  RalphRequestResult,
  type RalphPullRequestAction,
} from "@omniralph/shared";
import { notifyRunThread } from "./chat-notify";
import { conversationFor } from "./conversation";
import { settleFindingThreads } from "./finding-threads";
import { errorMessage, quietly, tail } from "./notify";
import { jobFailure } from "./outcome";
import {
  changeRequestTerm,
  laneRepository,
  postableText,
  sessionLinkLabel,
  type LinearLink,
  type PublishedLane,
} from "./publish";
import type { RalphDeps } from "./run";

/** The response to a mention without a request (cyralph's wording). */
export const NOTHING_TO_DO =
  "Nothing to do: the mention didn't include a request. Delegate the issue to me to work the epic.";

/** The response to a mention handed to the job that is running right now. */
export const PASSED_TO_RUNNING_JOB =
  "Passed this to the agent that's working on this epic right now; it will answer in that session.";

const ACTIVE_JOB_STATUSES = new Set<Job["status"]>(["queued", "running"]);

/**
 * Stores a mention's or reply's instruction on a run (inside `lockRun`;
 * cyralph's `onCreated`/`onPrompted`): `/ralph` switches a request-mode run to
 * epic mode, its pending requests becoming guidance too. In epic mode the
 * text is guidance (except a push/PR request, which no story agent may do)
 * and a pending request, unless the run waits after its PR/MR step failed
 * (the reply only retries that step); in request mode only a pending request.
 * Returns the run as it is now.
 */
export async function addInstruction(
  tx: RalphTransaction,
  run: RalphRun,
  input: { text: string; author?: string | null; wantsLoop: boolean; ship?: boolean },
  applyGuidance: (tx: RalphTransaction, run: RalphRun, text: string) => Promise<void>,
): Promise<{ run: RalphRun; switched: boolean }> {
  let current = run;
  let switched = false;
  if (input.wantsLoop && current.mode === "request") {
    current = (await updateRun(tx, current.id, { mode: "epic" })) ?? current;
    switched = true;
    const guidance = new Set(current.guidance.map((g) => g.text));
    for (const request of await listPendingRequests(tx, current.id)) {
      if (request.laneId || request.ship || guidance.has(request.text)) continue;
      await appendGuidance(tx, current.id, request.text);
    }
  }
  if (input.text) {
    // A run waiting after its PR/MR step failed: the reply (e.g. "retry") retries that step.
    // `/ship` is never guidance: it only runs as a request job.
    const retry =
      !input.ship && current.mode === "epic" && current.status === "waiting" && !!current.error;
    if (
      current.mode === "epic" &&
      !input.ship &&
      (retry || !asksForPushOrPullRequest(input.text))
    ) {
      await applyGuidance(tx, current, input.text);
    }
    if (retry) return { run: current, switched };
    await insertMessage(tx, {
      runId: current.id,
      kind: "request",
      text: input.text,
      author: input.author ?? null,
      ...(input.ship && { ship: true }),
    });
  }
  return { run: current, switched };
}

/** A lane with pending requests. */
export interface LaneRequests {
  lane: RalphLane;
  requests: RalphMessage[];
}

/**
 * The run's lanes with pending requests, the main lane first (cyralph's
 * `runAllRequests` order); requests without a lane are the main lane's.
 */
export async function pendingRequestLanes(
  tx: RalphTransaction,
  run: Pick<RalphRun, "id" | "repositoryId">,
): Promise<LaneRequests[]> {
  const pending = await listPendingRequests(tx, run.id);
  if (pending.length === 0) return [];
  const lanes = await listLanes(tx, run.id);
  const main = lanes.find((l) => l.repositoryId === run.repositoryId);
  const ordered = [...lanes].sort((a, b) => Number(b === main) - Number(a === main));
  return ordered
    .map((lane) => ({
      lane,
      requests: pending.filter((r) => (r.laneId ?? main?.id) === lane.id),
    }))
    .filter((l) => l.requests.length > 0);
}

/**
 * A story job is taking the main lane's pending requests as guidance (they
 * are in its prompt): they're handled. Push/PR requests and `/ship` stay
 * pending for a request job, since a story agent may not do them.
 */
export async function consumeStoryRequests(
  tx: RalphTransaction,
  run: Pick<RalphRun, "id">,
): Promise<void> {
  const taken = (await listPendingRequests(tx, run.id)).filter(
    (r) => !r.laneId && !r.ship && !asksForPushOrPullRequest(r.text),
  );
  await consumeMessages(
    tx,
    taken.map((r) => r.id),
  );
}

/** "Working on your request." (in another lane: "… in `repo`."). */
export function workingOnRequestsNote(count: number, repository: string | null): string {
  const where = repository ? ` in \`${repository}\`` : "";
  return count === 1
    ? `Working on your request${where}.`
    : `Working on your ${count} requests${where}.`;
}

/** The run's lanes with their repositories, the main lane first (for PR/MR links). */
export async function runLanes(
  deps: Pick<RalphDeps, "db">,
  tx: RalphTransaction,
  run: Pick<RalphRun, "id" | "repositoryId">,
): Promise<PublishedLane[]> {
  const lanes = await listLanes(tx, run.id);
  const out: PublishedLane[] = [];
  for (const lane of lanes.sort(
    (a, b) =>
      Number(b.repositoryId === run.repositoryId) - Number(a.repositoryId === run.repositoryId),
  )) {
    const found = await getRepositoryWithConnection(deps.db, lane.repositoryId);
    out.push({
      lane,
      repository: found?.repository ?? { provider: "github", fullPath: lane.repositoryId },
    });
  }
  return out;
}

/** Takes the run's request output (what request jobs said since its last response). */
export async function takeRequestOutput(
  tx: RalphTransaction,
  run: RalphRun,
): Promise<string | null> {
  const output = run.requestOutput?.trim() || null;
  if (run.requestOutput !== null) await updateRun(tx, run.id, { requestOutput: null });
  return output;
}

/**
 * Applies the outcome of the run's `ralph.request` job once it has finished
 * (inside the run's row lock, from `advanceRun`; cyralph's `runRequests`):
 * its requests are handled (a canceled job leaves them pending for the next
 * one), the lane keeps the Claude session for follow-ups on the agent that
 * ran it, a stash of what the session left uncommitted is recorded, the
 * PR/MR change it asked for is made, an open PR/MR for the branch is adopted,
 * the review findings it fixed or skipped get a reply in their threads (the
 * fixed ones resolved), and what it said is added to the run's request output (prefixed with the
 * repository when the run has several lanes). Returns whether the job is
 * still queued or running.
 */
export async function applyRequestJob(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
): Promise<{ busy: boolean }> {
  if (!run.requestJobId) return { busy: false };
  const job = await getJob(deps.db, run.requestJobId);
  if (job && ACTIVE_JOB_STATUSES.has(job.status)) return { busy: true };
  await updateRun(tx, run.id, { requestJobId: null });
  const payload = job ? RalphRequestPayload.safeParse(job.payload) : null;
  // Stopped: the requests stay pending, for the run's next request job.
  if (!job || !payload?.success || job.status === "canceled" || job.status === "skipped") {
    return { busy: false };
  }
  await consumeMessages(
    tx,
    payload.data.requests.map((r) => r.id),
  );
  const lanes = await listLanes(tx, run.id);
  const lane = lanes.find((l) => l.repositoryId === payload.data.repositoryId);
  const parsed = job.status === "completed" ? RalphRequestResult.safeParse(job.result) : null;

  let output: string;
  if (!parsed?.success) {
    const why = parsed ? "the agent sent an invalid result" : jobFailure(job);
    output = `I ran into an error working on your request: ${why}.`;
  } else {
    const result = parsed.data;
    const notes: string[] = [];
    if (lane) {
      await updateLane(tx, lane.id, {
        ...(result.sessionId && {
          requestClaudeSessionId: result.sessionId,
          requestHarnessId: job.harnessId,
        }),
        ...(result.stashSha && {
          stashes: [
            ...lane.stashes,
            { sha: result.stashSha, reason: "request", at: new Date().toISOString() },
          ],
        }),
      });
      const epic: LinearLink = {
        identifier: payload.data.epic.identifier,
        title: payload.data.epic.title,
        url: payload.data.epic.url,
        ...(!isLinearRun(run) && { fromChat: true }),
      };
      if (result.pullRequest) {
        const note = await applyPullRequestAction(deps, tx, run, lane, result.pullRequest, epic);
        if (note) notes.push(note);
      }
      await adoptPullRequest(deps, tx, run, lane);
      // A failed session's "fixed" is only its own claim (e.g. the push may
      // have failed), so its findings stay open.
      if (result.findings?.length && !result.error) {
        const current = (await listLanes(tx, run.id)).find((l) => l.id === lane.id) ?? lane;
        const settled = await settleFindingThreads(deps, current, result.findings);
        const n = settled.resolved.length;
        if (n > 0) {
          notes.push(`Resolved ${n} fixed review finding${n === 1 ? "" : "s"}.`);
        }
      }
    }
    const stashed = result.stashSha
      ? `The session left uncommitted changes, which I stashed as \`${result.stashSha.slice(0, 10)}\`.`
      : "";
    if (payload.data.ship && !result.error) notes.unshift(shipNote(result, payload.data.branch));
    output = result.error
      ? `I ran into an error working on your request: ${result.error}.\n\n${tail(result.summary, 2000)}`.trim()
      : result.summary.trim() || "Done.";
    output = [output, stashed, ...notes].filter(Boolean).join("\n\n");
  }
  const repository = payload.data.repository.fullPath;
  const prefixed =
    lanes.length > 1 || payload.data.repositoryId !== run.repositoryId
      ? `**${repository}**: ${output}`
      : output;
  await updateRun(tx, run.id, {
    requestOutput: [run.requestOutput?.trim(), prefixed].filter(Boolean).join("\n\n"),
  });
  return { busy: false };
}

/** What a `/ship` job did with git, for the thread. */
function shipNote(result: RalphRequestResult, branch: string): string {
  const commit = result.commitSha ? `Committed \`${result.commitSha.slice(0, 10)}\`` : "";
  if (result.pushed) {
    return commit ? `${commit} and pushed \`${branch}\`.` : `Pushed \`${branch}\`.`;
  }
  return commit ? `${commit}.` : `Nothing new to commit or push on \`${branch}\`.`;
}

/** Records a lane's PR/MR and adds it to the agent session. */
async function recordPullRequest(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  lane: RalphLane,
  repository: { provider: "github" | "gitlab"; fullPath: string },
  pr: { number: number; url: string },
): Promise<void> {
  if (lane.prNumber === pr.number && lane.prUrl === pr.url) return;
  await updateLane(tx, lane.id, { prNumber: pr.number, prUrl: pr.url });
  const label = await sessionLinkLabel(tx, run, repository, pr.number);
  const conversation = conversationFor(run, deps);
  await quietly(
    `Adding the ${changeRequestTerm(repository.provider)} to ${conversation.name}`,
    () => conversation.addLink(label, pr.url),
  );
  await notifyRunThread(deps, run, { kind: "pr_opened", label, url: pr.url });
}

/**
 * Picks up the PR/MR open for a lane's branch, when the lane has none yet
 * (cyralph's `adoptPullRequests`: e.g. a person opened it). Never opens one;
 * a failure is logged.
 */
async function adoptPullRequest(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  lane: RalphLane,
): Promise<void> {
  const current = (await listLanes(tx, run.id)).find((l) => l.id === lane.id) ?? lane;
  if (current.prUrl) return;
  await quietly(`Looking for an open PR/MR of ${current.branch}`, async () => {
    const target = await laneRepository(deps, current);
    const open = await target.adapter.findOpenChangeRequest(target.repo, current.branch);
    if (open) await recordPullRequest(deps, tx, run, current, target.repository, open);
  });
}

/**
 * Makes the PR/MR change a request session asked for (with v2a's SCM
 * operations and the sanitizer): `open` opens the lane's PR/MR as a draft
 * (or adopts the one open for its branch, with the new title and body),
 * `update` changes the open one's title or body, `ready` marks it ready for
 * review. The PR/MR is recorded on the lane. Returns a note for the thread
 * when it couldn't be done.
 */
export async function applyPullRequestAction(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  lane: RalphLane,
  action: RalphPullRequestAction,
  epic: LinearLink,
): Promise<string | null> {
  let term = "pull request";
  const verb = { open: "open", update: "update", ready: "mark ready" }[action.action];
  try {
    const target = await laneRepository(deps, lane);
    const { adapter, repo, repository } = target;
    term = changeRequestTerm(repository.provider);
    const open =
      lane.prNumber !== null && lane.prUrl && !lane.prClosed
        ? { number: lane.prNumber, url: lane.prUrl }
        : await adapter.findOpenChangeRequest(repo, lane.branch);

    if (action.action === "open") {
      const text = await postableText(
        target,
        {
          title: action.title ?? epic.title,
          body: action.body ?? `Changes for ${epic.identifier}: ${epic.title}.`,
        },
        epic,
      );
      if (open) {
        if (action.title || action.body) {
          await adapter.updateChangeRequest(repo, open.number, {
            ...(action.title && { title: text.title }),
            ...(action.body && { body: text.body }),
          });
        }
        await recordPullRequest(deps, tx, run, lane, repository, open);
        return null;
      }
      const created = await adapter.createChangeRequest(repo, {
        sourceBranch: lane.branch,
        targetBranch: lane.baseBranch,
        ...text,
        draft: true,
      });
      await recordPullRequest(deps, tx, run, lane, repository, created);
      return null;
    }

    if (!open) return `There's no open ${term} for \`${lane.branch}\` to ${verb}.`;
    if (action.action === "update") {
      if (action.title || action.body) {
        const text = await postableText(
          target,
          { title: action.title ?? "", body: action.body ?? "" },
          epic,
        );
        await adapter.updateChangeRequest(repo, open.number, {
          ...(action.title && { title: text.title }),
          ...(action.body && { body: text.body }),
        });
      }
    } else {
      await adapter.markChangeRequestReady(repo, open.number);
    }
    await recordPullRequest(deps, tx, run, lane, repository, open);
    return null;
  } catch (error) {
    return `I couldn't ${verb} the ${term}: ${tail(errorMessage(error), 1500)}`;
  }
}
