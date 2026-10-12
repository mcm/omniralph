import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isWaitingRequest,
  readRequestResult,
  REQUEST_OUTPUT_SCHEMA,
  type Epic,
  type ShipStash,
  type Story,
} from "@omniralph/ralph";
import {
  MAX_LEASE_SECONDS,
  ralphStashPrefix,
  type RalphPullRequestAction,
  type RalphRequestPayload,
  type RalphRequestResult,
} from "@omniralph/shared";
import { RetryableJobError, type JobContext } from "../capabilities/index.js";
import {
  createSessionRunner,
  type SessionRequest,
  type SessionResult,
} from "../session/session.js";
import { ActivityRelay } from "../tools/activities.js";
import { controlPanelFetcher, jobAttachments } from "../tools/attachments.js";
import type { BranchWorktree } from "../workspace/repoCache.js";
import type { StoryOptions } from "./story-attempt.js";

const MAX_TEXT = 20_000;

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Label prefix of a run's request stash entries (never offered to its stories). */
export function requestStashPrefix(payload: Pick<RalphRequestPayload, "runId">): string {
  return `${ralphStashPrefix(payload.runId)}request `;
}

/** The epic `buildRequestPrompt` expects, from the job's payload. */
export function requestEpic(payload: RalphRequestPayload): Epic {
  const stories: Story[] = payload.stories.map((s) => ({
    key: s.identifier,
    storyId: s.identifier,
    identifier: s.identifier,
    title: s.title,
    description: "",
    acceptanceCriteria: [],
    priority: 0,
    dependsOn: s.dependsOn,
    status: s.status,
    ...(s.manual && { manual: true }),
    ...(s.repository && { repo: { id: "", name: s.repository, routedBy: "" } }),
  }));
  return {
    kind: payload.epic.kind,
    issueId: "",
    identifier: payload.epic.identifier,
    title: payload.epic.title,
    description: payload.epic.prd,
    ...(payload.epic.url && { url: payload.epic.url }),
    branchName: payload.branch,
    qualityGates: payload.qualityGates,
    stories,
  };
}

/** What a session asks `ship` to do: commit with `message`, push (with a lease), make a PR/MR change. */
export interface ShipRequest {
  message?: string;
  pullRequest?: RalphPullRequestAction;
  /** Push with `--force-with-lease` (after a requested rebase); refused when history rewrites are off. */
  forceWithLease?: boolean;
}

/** What `ship` did: the commit it made, whether it pushed, or why it failed. */
export interface ShipOutcome {
  commitSha: string | null;
  pushed: boolean;
  error: string | null;
}

/** What a request attempt prepared before its session: the prompt and session settings are built from it. */
export interface RequestAttemptPrepared {
  /** The progress log the session may read (in `progressDir`). */
  progressFile: string;
  progressDir: string;
  /** The branch worktree the session runs in. */
  cwd: string;
  /** What the prompt says about the downloaded attachments; undefined without any. */
  attachments?: string;
  /** `/ship`: the run's request stash entries offered to the session, newest first. */
  shipStashes: ShipStash[];
  /**
   * Commits, pushes the run's branch with the lifecycle's git access and
   * records the PR/MR change for the result (the `ship` harness tool).
   */
  ship(request: ShipRequest): Promise<ShipOutcome>;
}

/** The session settings that differ between the legacy `ralph.request` job and a coding run. */
export type RequestSessionSettings = Pick<
  SessionRequest,
  | "prompt"
  | "policy"
  | "systemAppend"
  | "systemPrompt"
  | "model"
  | "fallbackModel"
  | "tools"
  | "env"
  | "mcpServers"
  | "skills"
  | "tokenBudget"
  | "maxTurns"
  | "idleTimeoutMs"
  | "askPermission"
>;

export interface RequestAttemptArgs {
  payload: RalphRequestPayload;
  /** The job (or run) whose activities and attachments the control panel serves. */
  jobId: string;
  ctx: JobContext;
  options: StoryOptions;
  /** The environment of the lifecycle's git commands: the worktree, and `/ship`'s and `ship`'s pushes. */
  gitEnv: NodeJS.ProcessEnv;
  /** The session's prompt and settings, from what the attempt prepared. */
  session(
    prepared: RequestAttemptPrepared,
  ): RequestSessionSettings | Promise<RequestSessionSettings>;
  /**
   * Runs in the branch worktree after the attempt, whatever happened (a
   * coding task's teardown commands); it must not throw.
   */
  teardown?(cwd: string): Promise<void>;
}

/** Why a session failed, in cyralph's words. */
function sessionError(session: SessionResult): string {
  return session.stop === "idle"
    ? `the session was stopped: ${session.error ?? "it was idle"}`
    : `the session failed: ${session.error ?? "unknown error"}`;
}

/**
 * Does what a lane's pending requests ask (ported from cyralph's
 * `EpicEngine.runRequests`): one Claude session in the lane's branch
 * worktree (with the repository's setup command and the `pre-push` guard),
 * after setting aside what an earlier session left (`pre-run`), with the
 * attachments and progress file and the session `args.session` describes.
 * PR/MR changes come back as `pullRequest` for the control panel to make.
 * The lane's previous request conversation is resumed when the payload
 * names it (retried fresh when the resume fails without a session). The
 * session may ship through `prepared.ship` (the `ship` harness tool), which
 * commits and pushes with `args.gitEnv`; `/ship` requests are committed and
 * pushed after the session the same way. What the session leaves uncommitted
 * is stashed and reported. Replies from the Linear thread reach the live
 * session. A Claude rate limit throws `RetryableJobError`; a canceled job
 * stashes its work and rejects. Shared by `ralph.request` jobs (`runRequest`)
 * and coding runs of request tasks (`runCodingTask`).
 */
export async function runRequestAttempt(args: RequestAttemptArgs): Promise<RalphRequestResult> {
  const { payload, ctx, options } = args;
  const started = Date.now();
  const log = ctx.logger.child({
    repo: `${payload.repository.provider}/${payload.repository.fullPath}`,
    branch: payload.branch,
    requests: payload.requests.length,
  });
  const relay = new ActivityRelay({
    server: ctx.server,
    jobId: args.jobId,
    jobToken: ctx.jobToken,
    logger: log,
    ...(options.fetch && { fetch: options.fetch }),
  });
  const runSession = options.runSession ?? createSessionRunner();
  const label = (reason: string) => `${requestStashPrefix(payload)}${reason}`;

  try {
    return await ctx.repos.withBranchWorktree(
      payload.repository,
      {
        branch: payload.branch,
        baseBranch: payload.baseBranch,
        ...(payload.settings.setupCommand && { setupCommand: payload.settings.setupCommand }),
        // A run pushing only at the end keeps its story commits on its hidden ref meanwhile.
        ...(payload.hiddenRef && { hiddenRef: payload.hiddenRef }),
        env: args.gitEnv,
        signal: ctx.signal,
      },
      async (worktree) => {
        // Whatever an earlier session left behind is set aside first (`/ship` ships it instead).
        const leftover = payload.ship ? null : await worktree.stashWork(label("pre-run"));
        if (leftover) {
          log.info({ stash: leftover }, "stashed leftover work");
          relay.post({
            type: "thought",
            body: `The worktree had uncommitted changes from an earlier session, so I stashed them first (\`${leftover.slice(0, 10)}\`).`,
            ephemeral: false,
          });
        }
        // Files attached in Linear, downloaded through the control panel (which holds the token).
        const attachments = await jobAttachments({
          attachments: payload.attachments,
          epicIdentifier: payload.epic.identifier,
          workspaceRoot: ctx.workspaceRoot,
          fetcher: controlPanelFetcher({
            server: ctx.server,
            jobId: args.jobId,
            jobToken: ctx.jobToken,
            signal: ctx.signal,
            ...(options.fetch && { fetch: options.fetch }),
          }),
          logger: log,
          report: (body) => relay.post({ type: "thought", body, ephemeral: false }),
        });
        const progressDir = await mkdtemp(path.join(tmpdir(), "omniralph-progress-"));
        const progressFile = path.join(progressDir, "progress.md");
        // What the session shipped through `prepared.ship`, one call at a time.
        const shipments: Shipped[] = [];
        let shipping: Promise<unknown> = Promise.resolve();
        const shipTool = (request: ShipRequest): Promise<ShipOutcome> => {
          const turn = shipping.then(async () => {
            const shipped = await ship(
              worktree,
              payload,
              { ...request, openWhenMissing: false },
              log,
            );
            shipments.push(shipped);
            if (shipped.error) {
              relay.post({ type: "thought", body: shipped.error, ephemeral: false });
            }
            return {
              commitSha: shipped.commitSha ?? null,
              pushed: shipped.pushed,
              error: shipped.error ?? null,
            };
          });
          shipping = turn.catch(() => {});
          return turn;
        };
        try {
          await writeFile(progressFile, payload.progress);
          const shipStashes = payload.ship ? await requestStashes(worktree, payload) : [];
          const settings = await args.session({
            progressFile,
            progressDir,
            cwd: worktree.path,
            ...(attachments.prompt && { attachments: attachments.prompt }),
            shipStashes,
            ship: shipTool,
          });
          const request: SessionRequest = {
            ...settings,
            cwd: worktree.path,
            outputSchema: REQUEST_OUTPUT_SCHEMA,
            isWaiting: isWaitingRequest,
            additionalDirectories: [
              progressDir,
              ...(attachments.files.length > 0 ? [attachments.dir] : []),
            ],
            signal: ctx.signal,
            onEvent: (event) => relay.event(event),
            // Replies from the Linear thread reach the live session (see `jobMessages`).
            onInjector: (inject) => ctx.setMessageInjector?.(inject),
            // Follow-ups continue this conversation, like Cyrus resuming its Claude session.
            persistSession: true,
          };
          const resume = payload.resumeSessionId ?? undefined;
          let session = await runSession({ ...request, ...(resume && { resume }) });
          if (resume && session.stop === "error" && !session.sessionId && !ctx.signal.aborted) {
            log.warn({ resume }, "could not resume the request session; starting fresh");
            session = await runSession(request);
          }
          // A `ship` call still running when the session ended finishes first.
          await shipping;

          if (session.stop === "aborted" || ctx.signal.aborted) {
            await stashQuietly(worktree, label("stopped"), log);
            throw ctx.signal.reason ?? new Error("the request session was aborted");
          }
          if (session.stop === "rate_limited") {
            await stashQuietly(worktree, label("rate-limited"), log);
            const seconds =
              session.retryAfterMs !== undefined
                ? Math.ceil(session.retryAfterMs / 1000)
                : (options.defaultRetryAfterSeconds ?? 300);
            throw new RetryableJobError(
              session.error ?? "Claude rate limit",
              Math.min(Math.max(seconds, 1), MAX_LEASE_SECONDS),
            );
          }

          const read =
            session.stop === "completed" ? readRequestResult(session.structured) : undefined;
          const stoppedWaiting =
            session.stop === "completed" && isWaitingRequest(session.structured);
          const valid = read && !("problem" in read) && !stoppedWaiting ? read.result : undefined;
          // `/ship`: the job commits and pushes what the session prepared.
          const shipped =
            payload.ship && valid
              ? await ship(
                  worktree,
                  payload,
                  {
                    ...(valid.commit?.message && { message: valid.commit.message }),
                    ...(valid.pullRequest && { pullRequest: valid.pullRequest }),
                    openWhenMissing: true,
                  },
                  log,
                )
              : undefined;
          if (shipped) shipments.push(shipped);
          // The agent commits what it means to keep; anything else is set aside so the next session starts clean.
          const stashSha = await stashQuietly(worktree, label("unfinished"), log);
          const commitSha = shipments.findLast((s) => s.commitSha)?.commitSha;
          const base = {
            sessionId: session.sessionId ?? null,
            ...(stashSha && { stashSha }),
            ...(commitSha && { commitSha }),
            ...(shipments.length > 0 && { pushed: shipments.some((s) => s.pushed) }),
            usage: session.usage,
            durationMs: Date.now() - started,
          };
          if (shipped?.error) {
            return { ...base, summary: clip(valid?.summary ?? ""), error: clip(shipped.error) };
          }
          if (!read || "problem" in read || stoppedWaiting) {
            const why = stoppedWaiting
              ? `the session was stopped while it waited for background work: ${session.error ?? "it gave up waiting"}`
              : read && "problem" in read
                ? `it ended without a valid structured result (${read.problem})`
                : sessionError(session);
            return {
              ...base,
              summary: clip(tail(session.output, 2000)),
              error: clip(why),
            };
          }
          log.info(
            {
              pullRequest: read.result.pullRequest?.action ?? null,
              findings: read.result.findings?.length ?? 0,
            },
            "request done",
          );
          // The structured result's change wins; then the last one asked for through `ship`.
          const pullRequest =
            read.result.pullRequest ?? shipments.findLast((s) => s.pullRequest)?.pullRequest;
          return {
            ...base,
            summary: clip(read.result.summary),
            error: null,
            ...(pullRequest && {
              pullRequest: {
                action: pullRequest.action,
                ...(pullRequest.title && { title: clip(pullRequest.title, 500) }),
                ...(pullRequest.body && { body: clip(pullRequest.body, 60_000) }),
              },
            }),
            ...(read.result.findings && {
              findings: read.result.findings.map((f) => ({
                findingId: f.id,
                outcome: f.outcome,
                comment: f.comment,
              })),
            }),
          };
        } catch (error) {
          if (ctx.signal.aborted) await stashQuietly(worktree, label("stopped"), log);
          throw error;
        } finally {
          await rm(progressDir, { recursive: true, force: true });
          await args.teardown?.(worktree.path);
        }
      },
    );
  } finally {
    await relay.flush();
  }
}

/** The run's request stash entries in the stash list, newest first (offered to a `/ship` session). */
async function requestStashes(
  worktree: BranchWorktree,
  payload: RalphRequestPayload,
): Promise<ShipStash[]> {
  const prefix = requestStashPrefix(payload);
  const entries = await worktree.listStashes();
  return entries
    .filter((e) => e.label.startsWith(prefix))
    .slice(0, 20)
    .map((e) => ({ sha: e.sha, label: e.label, date: e.date }));
}

/** Identity for commits on hosts without a git `user.email`. */
const FALLBACK_IDENTITY = ["-c", "user.name=Omniralph", "-c", "user.email=omniralph@localhost"];

/** What `ship` did: the commit it made, whether it pushed, the PR/MR change to make, or why it failed. */
interface Shipped {
  commitSha?: string;
  pushed: boolean;
  pullRequest?: RalphPullRequestAction;
  error?: string;
}

interface ShipArgs extends ShipRequest {
  /** `/ship`: ask for the PR/MR to be opened when the lane has none and the branch is ahead of its base. */
  openWhenMissing: boolean;
}

/**
 * Ships the worktree (`/ship` after its session, or the `ship` harness tool
 * during one): commits everything with `args.message` (outside Claude Code,
 * so the repository's `ask` rules don't apply), pushes the run's branch with
 * `-u` when `origin` doesn't have its head (`--force-with-lease` when asked
 * and history rewrites are allowed), and reports the PR/MR change asked for.
 * Only the run's branch is ever pushed, and only when the worktree is on it.
 * A failed commit or push undoes the commit (its changes are then stashed
 * with the rest, or left for the session) and reports why.
 */
async function ship(
  worktree: BranchWorktree,
  payload: RalphRequestPayload,
  args: ShipArgs,
  log: JobContext["logger"],
): Promise<Shipped> {
  // Set once the commit exists and until it's pushed: an unexpected failure undoes it.
  const state: { unpushedCommit?: string } = {};
  try {
    return await shipSteps(worktree, payload, args, log, state);
  } catch (error) {
    log.warn({ err: error }, "shipping failed");
    if (state.unpushedCommit) {
      await worktree.git(["reset", "--quiet", "HEAD~1"]).catch(() => {});
    }
    return {
      pushed: false,
      error: `shipping failed${state.unpushedCommit ? " (the commit was undone)" : ""}:\n\n\`\`\`\n${tail(errorText(error), 4000)}\n\`\`\``,
    };
  }
}

async function shipSteps(
  worktree: BranchWorktree,
  payload: RalphRequestPayload,
  args: ShipArgs,
  log: JobContext["logger"],
  state: { unpushedCommit?: string },
): Promise<Shipped> {
  const git = (gitArgs: readonly string[]) => worktree.git(gitArgs);
  const tryGit = (gitArgs: readonly string[]) =>
    git(gitArgs).then(
      (out) => out.trim(),
      () => null,
    );
  const remoteHead = () =>
    tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${payload.branch}`]);

  if (args.forceWithLease && payload.historyRewrite === "never") {
    return {
      pushed: false,
      error:
        "history rewrites are disabled for this repository, so `forceWithLease` was refused: nothing was committed or pushed",
    };
  }
  const current = await tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current !== payload.branch) {
    return {
      pushed: false,
      error: `the worktree is on ${current ? `\`${current}\`` : "a detached HEAD"}, not \`${payload.branch}\`: only \`${payload.branch}\` is shipped, so nothing was committed or pushed`,
    };
  }

  let commitSha: string | undefined;
  await git(["add", "-A"]);
  const staged = (await git(["diff", "--cached", "--name-only"])).trim();
  if (staged) {
    const message = args.message?.trim();
    if (!message) {
      await git(["reset", "--quiet"]);
      return {
        pushed: false,
        error:
          "the session left uncommitted changes but no commit message, so nothing was committed or pushed",
      };
    }
    const identity = (await tryGit(["config", "--get", "user.email"])) ? [] : FALLBACK_IDENTITY;
    try {
      await git([...identity, "commit", "--quiet", "-m", message]);
    } catch (error) {
      await git(["reset", "--quiet"]).catch(() => {});
      return {
        pushed: false,
        error: `committing the work failed (e.g. a git hook rejected it):\n\n\`\`\`\n${tail(errorText(error), 4000)}\n\`\`\``,
      };
    }
    state.unpushedCommit = "HEAD";
    commitSha = (await git(["rev-parse", "HEAD"])).trim();
    state.unpushedCommit = commitSha;
    log.info({ commit: commitSha }, "committed the shipped work");
  }

  const head = (await git(["rev-parse", "HEAD"])).trim();
  let pushed = false;
  if ((await remoteHead()) !== head) {
    const lease = args.forceWithLease ? ["--force-with-lease"] : [];
    try {
      await git(["push", "--quiet", "-u", ...lease, "origin", payload.branch]);
      delete state.unpushedCommit;
      pushed = true;
      log.info({ head, forceWithLease: lease.length > 0 }, "pushed the shipped branch");
    } catch (error) {
      // Undo the commit, so its changes are stashed with the rest instead of lost in a local commit.
      if (commitSha) await git(["reset", "--quiet", "HEAD~1"]).catch(() => {});
      delete state.unpushedCommit;
      return {
        pushed: false,
        error: `${commitSha ? "the work was committed, but pushing it failed, so the commit was undone" : "pushing the branch failed"}:\n\n\`\`\`\n${tail(errorText(error), 4000)}\n\`\`\``,
      };
    }
  }

  let pullRequest = args.pullRequest;
  // `/ship` with no PR/MR yet: open one when the branch has something to review.
  if (args.openWhenMissing && !payload.prUrl && !pullRequest) {
    const ahead = await tryGit(["rev-list", "--count", `origin/${payload.baseBranch}..HEAD`]);
    if (ahead !== null && Number(ahead) > 0) {
      const [subject, ...rest] = (args.message ?? "").split("\n");
      const body = rest.join("\n").trim();
      pullRequest = {
        action: "open",
        ...(subject?.trim() && { title: subject.trim() }),
        ...(body && { body }),
      };
    }
  }
  return { ...(commitSha && { commitSha }), pushed, ...(pullRequest && { pullRequest }) };
}

/** An error's message (a git failure's includes its output). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stashes the worktree's changes (even after a cancel); the stash SHA, or null. A failure is logged. */
async function stashQuietly(
  worktree: BranchWorktree,
  label: string,
  log: JobContext["logger"],
): Promise<string | null> {
  try {
    const sha = await worktree.stashWork(label, { signal: null });
    if (sha) log.info({ stash: sha, label }, "stashed the request's work");
    return sha;
  } catch (error) {
    log.warn({ err: error, label }, "stashing the request's work failed");
    return null;
  }
}
