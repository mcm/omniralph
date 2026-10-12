import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseStoryBody,
  isWaitingStory,
  readStoryOutcome,
  STORY_OUTPUT_SCHEMA,
  uniqueCommands,
  type Epic,
  type OfferedStash,
  type Story,
  type StoryOutcome,
} from "@omniralph/ralph";
import {
  MAX_LEASE_SECONDS,
  ralphStashPrefix,
  type RalphFollowUp,
  type RalphStoryPayload,
  type RalphStoryResult,
  type RalphStoryStatus,
} from "@omniralph/shared";
import type { FetchFn } from "../api.js";
import { RetryableJobError, type JobContext } from "../capabilities/index.js";
import { jobGitAccess } from "../capabilities/ralph/git-access.js";
import { withoutJobEnv } from "../job-env.js";
import {
  createSessionRunner,
  type SessionRequest,
  type SessionResult,
  type SessionRunner,
} from "../session/session.js";
import { ActivityRelay } from "../tools/activities.js";
import { controlPanelFetcher, jobAttachments } from "../tools/attachments.js";
import type { BranchWorktree } from "../workspace/repoCache.js";
import { CommandError, GitError, runShell } from "../workspace/git.js";

/** The Claude model of a repository whose ralph settings name none. */
export const DEFAULT_STORY_MODEL = "opus";

/** Longest command output (tail) quoted as feedback. */
const MAX_FEEDBACK_OUTPUT = 6000;
const MAX_TEXT = 20_000;

/** Identity for story commits on hosts without a git `user.name`/`user.email`. */
const FALLBACK_IDENTITY = ["-c", "user.name=Omniralph", "-c", "user.email=omniralph@localhost"];

export interface StoryOptions {
  /** Runs the Claude session; defaults to the Agent SDK. Injected in tests. */
  runSession?: SessionRunner;
  /** For relaying activities; defaults to the global `fetch`. */
  fetch?: FetchFn;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
  idleTimeoutMs?: number;
  /** How often the job token file git reads is refreshed (see `jobGitAccess`). */
  tokenRefreshMs?: number;
  /** Request sessions: how long a permission question in Linear waits for an answer. */
  permissionTimeoutMs?: number;
  /** Request sessions: how often the answer to a permission question is polled for. */
  permissionPollIntervalMs?: number;
  now?: () => Date;
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Label prefix of a story's stash entries: they're offered to the story's later attempts. */
export function stashPrefix(payload: Pick<RalphStoryPayload, "runId" | "story">): string {
  return `${ralphStashPrefix(payload.runId)}${payload.story.identifier} `;
}

/** The epic and story `buildStoryPrompt` expects, from the job's payload. */
export function promptEpic(payload: RalphStoryPayload): { epic: Epic; story: Story } {
  const body = parseStoryBody(payload.story.description);
  // A story worked in another repository than the epic's main one (its lane's).
  const repo = (name: string | null | undefined) =>
    name ? { repo: { id: "", name, routedBy: "" } } : {};
  const listed = payload.stories.find((s) => s.identifier === payload.story.identifier);
  const story: Story = {
    key: payload.story.identifier,
    storyId: payload.story.identifier,
    identifier: payload.story.identifier,
    issueId: payload.story.linearIssueId,
    ...(payload.story.url && { url: payload.story.url }),
    title: payload.story.title,
    description: body.description,
    acceptanceCriteria: body.acceptanceCriteria,
    priority: 0,
    dependsOn: listed?.dependsOn ?? [],
    status: "in_progress",
    ...repo(listed?.repository),
  };
  const stories: Story[] = payload.stories.map((s) =>
    s.identifier === story.key
      ? story
      : {
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
          ...repo(s.repository),
        },
  );
  if (!stories.includes(story)) stories.push(story);
  const epic: Epic = {
    kind: payload.epic.kind,
    issueId: "",
    identifier: payload.epic.identifier,
    title: payload.epic.title,
    description: payload.epic.prd,
    ...(payload.epic.url && { url: payload.epic.url }),
    branchName: payload.branch,
    // The PRD's gates; the ones the job runs are listed as checked by the orchestrator instead.
    qualityGates: payload.prdQualityGates,
    stories,
  };
  return { epic, story };
}

/** Why a session's attempt failed, for the next attempt. */
function sessionFeedback(session: SessionResult): string {
  const what =
    session.stop === "idle"
      ? `was stopped: ${session.error ?? "it was idle"}`
      : `failed: ${session.error ?? "unknown error"}`;
  return `The previous session ${what}. Last message:\n\n${quote(tail(session.output, 2000))}`;
}

/** Follow-ups that fit `RalphStoryResult`. */
function followUpsOf(outcome: StoryOutcome | undefined): RalphFollowUp[] {
  return (outcome?.followUps ?? []).map((f) => ({
    title: clip(f.title, 255),
    description: clip(f.description),
    manual: f.manual === true,
  }));
}

/** What an attempt prepared before its session: the prompt and session settings are built from it. */
export interface StoryAttemptPrepared {
  /** The run's stashes offered to the session. */
  offered: OfferedStash[];
  /** What the prompt says about the downloaded attachments; undefined without any. */
  attachments?: string;
  /** The progress log the session may update (in `progressDir`). */
  progressFile: string;
  progressDir: string;
  /** The branch worktree the session runs in. */
  cwd: string;
}

/** The session settings that differ between the legacy `ralph.story` job and a coding run. */
export type StorySessionSettings = Pick<
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
>;

export interface StoryAttemptArgs {
  payload: RalphStoryPayload;
  /** The job (or run) whose activities and attachments the control panel serves. */
  jobId: string;
  ctx: JobContext;
  options: StoryOptions;
  /** The session's prompt and settings, from what the attempt prepared. */
  session(prepared: StoryAttemptPrepared): StorySessionSettings | Promise<StorySessionSettings>;
  /**
   * Runs in the branch worktree after the attempt, whatever happened (a
   * coding task's teardown commands); it must not throw.
   */
  teardown?(cwd: string): Promise<void>;
  /**
   * A run that pushes only at the end (`pushTiming: end`): the hidden ref
   * (`ralphHiddenRef`) story commits are force-pushed to instead of the
   * branch, and the worktree starts from. Unset pushes the branch.
   */
  hiddenRef?: string;
}

/**
 * Runs one attempt at one story (ported from cyralph's `EpicEngine.runStory`):
 * in the epic's branch worktree (with the repository's setup command and the
 * `pre-push` guard), set aside leftover work (`pre-run`), offer the story's
 * stashes, download the attachments, write the progress file and run the
 * Claude session `args.session` describes, then on `complete` run the quality
 * gates, commit, require a clean tree and push with `-u` through the
 * brokered helper with the job's (lifecycle) token (or, with `hiddenRef`,
 * force-push HEAD to that ref and leave the branch on `origin` alone). Work of an attempt that
 * doesn't complete is stashed and offered to the story's next attempt, except
 * a blocked story's work that passes the gates: that is committed as
 * `wip(<ID>): …` and pushed. A failed push resets the commit, so the work is
 * stashed. Activities are relayed to the agent session while the session
 * runs. A Claude rate limit throws `RetryableJobError`; a canceled job
 * stashes its work and rejects. Shared by `ralph.story` jobs (`runStory`) and
 * coding runs of story tasks (`runCodingTask`).
 */
export async function runStoryAttempt(args: StoryAttemptArgs): Promise<RalphStoryResult> {
  const { payload, ctx, options } = args;
  const started = Date.now();
  const log = ctx.logger.child({
    repo: `${payload.repository.provider}/${payload.repository.fullPath}`,
    branch: payload.branch,
    story: payload.story.identifier,
    attempt: payload.attempt,
  });
  const relay = new ActivityRelay({
    server: ctx.server,
    jobId: args.jobId,
    jobToken: ctx.jobToken,
    logger: log,
    ...(options.fetch && { fetch: options.fetch }),
  });
  const runSession = options.runSession ?? createSessionRunner();
  // Quality gates never see a token.
  const plainEnv = withoutJobEnv(ctx.env());
  // The job's own git commands read the job token from a file kept current: the push comes after the session.
  const git = await jobGitAccess(ctx, { refreshMs: options.tokenRefreshMs });
  const prefix = stashPrefix(payload);
  const label = (reason: string) => `${prefix}${reason} (attempt ${payload.attempt})`;

  try {
    return await ctx.repos.withBranchWorktree(
      payload.repository,
      {
        branch: payload.branch,
        baseBranch: payload.baseBranch,
        ...(payload.settings.setupCommand && { setupCommand: payload.settings.setupCommand }),
        ...(args.hiddenRef && { hiddenRef: args.hiddenRef }),
        env: git.env,
        signal: ctx.signal,
      },
      async (worktree) => {
        // Whatever an earlier session left behind is set aside first, so this story's commit holds only its work.
        const leftover = await worktree.stashWork(label("pre-run"));
        if (leftover) {
          log.info({ stash: leftover }, "stashed leftover work");
          relay.post({
            type: "thought",
            body: `The worktree had uncommitted changes from an earlier session, so I stashed them first (\`${leftover.slice(0, 10)}\`).`,
            ephemeral: false,
          });
        }
        const offered: OfferedStash[] = (await worktree.listStashes())
          .filter((e) => e.label.startsWith(prefix))
          .map((e) => ({ sha: e.sha, label: e.label, date: e.date }));

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
        try {
          await writeFile(progressFile, payload.progress);
          const settings = await args.session({
            offered,
            ...(attachments.prompt && { attachments: attachments.prompt }),
            progressFile,
            progressDir,
            cwd: worktree.path,
          });
          const session = await runSession({
            ...settings,
            cwd: worktree.path,
            outputSchema: STORY_OUTPUT_SCHEMA,
            isWaiting: isWaitingStory,
            additionalDirectories: [
              progressDir,
              ...(attachments.files.length > 0 ? [attachments.dir] : []),
            ],
            signal: ctx.signal,
            onEvent: (event) => relay.event(event),
            // Replies from the Linear thread reach the live session (see `jobMessages`).
            onInjector: (inject) => ctx.setMessageInjector?.(inject),
          });
          const after = await readFile(progressFile, "utf8").catch(() => payload.progress);
          const progress = after !== payload.progress ? { progress: after } : {};

          if (session.stop === "aborted" || ctx.signal.aborted) {
            await stashQuietly(worktree, label("stopped"), log);
            throw ctx.signal.reason ?? new Error("the story session was aborted");
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

          // The structured result alone decides the outcome; the message text is only shown.
          const read =
            session.stop === "completed" ? readStoryOutcome(session.structured) : undefined;
          const outcome = read && "outcome" in read ? read.outcome : undefined;
          await dropApplied(worktree, offered, outcome?.appliedStashes ?? [], log);
          const summary = clip(outcome?.summary.trim() || session.output.trim());
          const followUps = followUpsOf(outcome);
          const result = (
            status: RalphStoryStatus,
            extra: { feedback: string | null; commitSha?: string; hiddenRef?: HiddenRefPush },
          ): RalphStoryResult => ({
            status,
            summary,
            ...(extra.commitSha && { commitSha: extra.commitSha }),
            ...(extra.hiddenRef && { hiddenRef: extra.hiddenRef }),
            followUps,
            feedback: extra.feedback === null ? null : clip(extra.feedback),
            ...progress,
            usage: session.usage,
            durationMs: Date.now() - started,
          });
          const notDone = async (status: RalphStoryStatus, feedback: string, reason: string) => {
            // Nothing uncommitted carries over: the next attempt starts clean and is offered the stash.
            await stashQuietly(worktree, label(reason), log);
            return result(status, { feedback });
          };

          if (!outcome) {
            const feedback =
              session.stop !== "completed"
                ? sessionFeedback(session)
                : `The previous session ended without a valid structured result (${read && "problem" in read ? read.problem : "none"}). End the session with a result matching the JSON schema you are given. Its final message was:\n\n${quote(tail(session.output, 3000))}`;
            return notDone("failed", feedback, "error");
          }
          if (outcome.status === "blocked") {
            const feedback = `The previous session reported it was blocked. Its summary was:\n\n${quote(tail(summary, 3000))}`;
            const kept = await commitBlockedWork({
              worktree,
              payload,
              summary: outcome.commit?.summary ?? payload.story.title,
              hiddenRef: args.hiddenRef,
              env: plainEnv,
              signal: ctx.signal,
              relay,
              log,
            });
            if (!kept.sha) {
              const why = kept.note ? `${feedback}\n\n${kept.note}` : feedback;
              return notDone("blocked", why, "blocked");
            }
            // Anything the commit didn't take is set aside like any blocked work, offered again next time.
            await stashQuietly(worktree, label("blocked"), log);
            for (const entry of offered) {
              await worktree.dropStash(entry.sha).catch((error: unknown) => {
                log.warn({ err: error, stash: entry.sha }, "dropping a stash failed");
              });
            }
            return result("blocked", {
              feedback: `${feedback}\n\nIts work so far is committed on the branch as \`${kept.sha.slice(0, 10)}\`.`,
              commitSha: kept.sha,
              ...(kept.hiddenRef && { hiddenRef: kept.hiddenRef }),
            });
          }
          if (outcome.status === "waiting") {
            // The session stopped waiting for its background work (see `runQuery`).
            return notDone(
              "incomplete",
              `The previous session was stopped while it waited for background work (${session.error ?? "it gave up waiting"}). Its summary was:\n\n${quote(tail(summary, 3000))}`,
              "waiting",
            );
          }
          if (outcome.status === "incomplete") {
            return notDone(
              "incomplete",
              `The previous session reported the story incomplete. Its summary was:\n\n${quote(tail(summary, 3000))}`,
              "incomplete",
            );
          }

          const gateFailure = await runQualityGates(
            uniqueCommands(payload.qualityGates),
            worktree.path,
            plainEnv,
            ctx.signal,
            relay,
          );
          if (gateFailure) {
            return notDone(
              "failed",
              `The agent reported the story complete, but ${gateFailureText(gateFailure)}`,
              "unverified",
            );
          }

          const commit = await commitStory(worktree, commitMessage(payload));
          if ("feedback" in commit) return notDone("failed", commit.feedback, "uncommitted");

          let pushed: HiddenRefPush | undefined;
          try {
            pushed = await pushWork(worktree, payload, args.hiddenRef);
          } catch (error) {
            ctx.signal.throwIfAborted();
            log.warn({ err: error }, "pushing the story failed");
            // Undo the commit, so the work is offered to the next attempt like any other.
            if (commit.sha) await worktree.git(["reset", "--quiet", "HEAD~1"]);
            return notDone(
              "failed",
              `The story's work was committed, but pushing it failed, so the commit was undone:\n\n\`\`\`\n${tail(errorText(error), MAX_FEEDBACK_OUTPUT)}\n\`\`\``,
              "push-failed",
            );
          }
          // The story's work is committed: its stash entries are in the commit or deliberately left out.
          for (const entry of offered) {
            await worktree.dropStash(entry.sha).catch((error: unknown) => {
              log.warn({ err: error, stash: entry.sha }, "dropping a stash failed");
            });
          }
          log.info(
            { commit: commit.sha ?? null, hiddenRef: pushed?.ref ?? null },
            "story complete",
          );
          return result("complete", {
            feedback: null,
            ...(commit.sha && { commitSha: commit.sha }),
            ...(pushed && { hiddenRef: pushed }),
          });
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
    await git.close();
    await relay.flush();
  }
}

/** What a push to the run's hidden ref pushed. */
type HiddenRefPush = NonNullable<RalphStoryResult["hiddenRef"]>;

/**
 * Pushes the story's work: the branch with `-u`, or with `hiddenRef`, HEAD
 * force-pushed to that ref (the branch on `origin` isn't touched). Returns
 * what was pushed to the hidden ref.
 */
async function pushWork(
  worktree: BranchWorktree,
  payload: RalphStoryPayload,
  hiddenRef: string | undefined,
): Promise<HiddenRefPush | undefined> {
  if (!hiddenRef) {
    await worktree.git(["push", "--quiet", "-u", "origin", payload.branch]);
    return undefined;
  }
  return { ref: hiddenRef, sha: await worktree.pushHiddenRef(hiddenRef) };
}

function errorText(error: unknown): string {
  if (error instanceof CommandError) return error.output;
  if (error instanceof GitError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Stashes the worktree's changes (even after a cancel); a failure is logged. */
async function stashQuietly(
  worktree: BranchWorktree,
  label: string,
  log: JobContext["logger"],
): Promise<void> {
  try {
    const sha = await worktree.stashWork(label, { signal: null });
    if (sha) log.info({ stash: sha, label }, "stashed the story's work");
  } catch (error) {
    log.warn({ err: error, label }, "stashing the story's work failed");
  }
}

/** Drops the offered entries the session applied (by full or abbreviated SHA). */
async function dropApplied(
  worktree: BranchWorktree,
  offered: readonly OfferedStash[],
  applied: readonly string[],
  log: JobContext["logger"],
): Promise<void> {
  const wanted = applied.map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 7);
  for (const entry of offered) {
    if (!wanted.some((x) => entry.sha.startsWith(x))) continue;
    await worktree.dropStash(entry.sha).catch((error: unknown) => {
      log.warn({ err: error, stash: entry.sha }, "dropping an applied stash failed");
    });
  }
}

interface GateFailure {
  gate: string;
  exitCode: number | null;
  output: string;
}

/** "the quality gate `x` failed (exit n):" and the output's tail. */
function gateFailureText(failure: GateFailure): string {
  const exit = failure.exitCode !== null ? ` (exit ${failure.exitCode})` : "";
  return `the quality gate \`${failure.gate}\` failed${exit}:\n\n\`\`\`\n${tail(failure.output, MAX_FEEDBACK_OUTPUT)}\n\`\`\``;
}

/** Runs the gates in order (`bash -lc`); the first failure, if any. */
async function runQualityGates(
  gates: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  relay: ActivityRelay,
): Promise<GateFailure | undefined> {
  for (const gate of gates) {
    relay.post({ type: "action", body: "Quality gate", parameter: gate, ephemeral: true });
    try {
      await runShell(gate, { cwd, env, signal });
    } catch (error) {
      signal.throwIfAborted();
      const exitCode = error instanceof CommandError ? error.exitCode : null;
      return { gate, exitCode, output: errorText(error) };
    }
  }
  return undefined;
}

/** The story commit's message: the payload's, with the epic for a story of one. */
function commitMessage(payload: RalphStoryPayload, subject = payload.commitMessage): string {
  return payload.epic.kind === "single"
    ? subject
    : `${subject}\n\nEpic: ${payload.epic.identifier} ${payload.epic.title}`;
}

/**
 * Commits a blocked story's work so far as `wip(<ID>): <summary>` once the
 * story's quality gates pass, and pushes it (cyralph's `commitBlockedWork`;
 * to the run's hidden ref when there is one),
 * so it survives on the branch whichever agent picks the run up next. A clean
 * tree commits nothing. A failing gate, commit or push leaves the work
 * uncommitted (the caller stashes it), with a note saying why.
 */
async function commitBlockedWork(args: {
  worktree: BranchWorktree;
  payload: RalphStoryPayload;
  summary: string;
  hiddenRef: string | undefined;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  relay: ActivityRelay;
  log: JobContext["logger"];
}): Promise<{ sha?: string; hiddenRef?: HiddenRefPush; note?: string }> {
  const { worktree, payload, env, signal, relay, log } = args;
  const changes = await worktree.git(["status", "--porcelain", "--untracked-files=all"]);
  if (!changes.trim()) return {};
  const failure = await runQualityGates(
    uniqueCommands(payload.qualityGates),
    worktree.path,
    env,
    signal,
    relay,
  );
  if (failure) {
    return {
      note: `Its work so far wasn't committed because ${gateFailureText(failure)}`,
    };
  }
  const subject = `wip(${payload.story.identifier}): ${args.summary.replace(/\s+/g, " ").trim()}`;
  const commit = await commitStory(worktree, commitMessage(payload, subject), {
    keepLeftovers: true,
  });
  if ("feedback" in commit) {
    return { note: "Its work so far passed the quality gates, but committing it failed." };
  }
  if (!commit.sha) return {};
  let pushed: HiddenRefPush | undefined;
  try {
    pushed = await pushWork(worktree, payload, args.hiddenRef);
  } catch (error) {
    signal.throwIfAborted();
    log.warn({ err: error }, "pushing the blocked story's work failed");
    await worktree.git(["reset", "--quiet", "HEAD~1"]);
    return {
      note: `Its work so far was committed, but pushing it failed, so the commit was undone:\n\n\`\`\`\n${tail(errorText(error), MAX_FEEDBACK_OUTPUT)}\n\`\`\``,
    };
  }
  log.info({ commit: commit.sha }, "committed the blocked story's work");
  relay.post({
    type: "thought",
    body: `Committed ${payload.story.identifier}'s work so far as \`${commit.sha.slice(0, 10)}\` (\`${subject}\`).`,
    ephemeral: false,
  });
  return { sha: commit.sha, ...(pushed && { hiddenRef: pushed }) };
}

/**
 * Commits everything as `message`, then requires a clean tree (unless
 * `keepLeftovers`). A failed commit, or files left over afterwards (undoing
 * the commit), give feedback instead. No changes at all: nothing to commit,
 * no SHA.
 */
async function commitStory(
  worktree: BranchWorktree,
  message: string,
  options: { keepLeftovers?: boolean } = {},
): Promise<{ sha?: string } | { feedback: string }> {
  await worktree.git(["add", "-A"]);
  const staged = await worktree.git(["diff", "--cached", "--name-only"]);
  if (!staged.trim()) return {};
  const identity = await worktree.git(["config", "--get", "user.email"]).then(
    (email) => (email.trim() ? [] : FALLBACK_IDENTITY),
    () => FALLBACK_IDENTITY,
  );
  try {
    await worktree.git([...identity, "commit", "--quiet", "-m", message]);
  } catch (error) {
    return {
      feedback: `The agent reported the story complete and the quality gates passed, but committing the work failed:\n\n\`\`\`\n${tail(errorText(error), MAX_FEEDBACK_OUTPUT)}\n\`\`\`\n\nFix what stops the commit (for example a git hook that rejects it). Don't commit yourself: the job commits once the story completes.`,
    };
  }
  const sha = (await worktree.git(["rev-parse", "HEAD"])).trim();
  if (options.keepLeftovers) return { sha };
  const left = (await worktree.git(["status", "--porcelain", "--untracked-files=all"]))
    .split("\n")
    .filter(Boolean);
  if (left.length === 0) return { sha };
  await worktree.git(["reset", "--quiet", "HEAD~1"]);
  const shown =
    left.slice(0, 50).join("\n") + (left.length > 50 ? `\n… and ${left.length - 50} more` : "");
  return {
    feedback: `The agent reported the story complete, but after the job committed it these files were still uncommitted (\`git status --porcelain\`), so the commit was undone:\n\n\`\`\`\n${shown}\n\`\`\`\n\nThe worktree must be clean when the story is done. Files that belong to the story must be committable (not inside a nested git repository, not rewritten by a git hook after staging); anything else should be deleted, or added to \`.gitignore\` if it's generated. Don't commit yourself: the job commits once the story completes.`,
  };
}
