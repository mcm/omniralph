/**
 * The payload of a `ralph.story` job: everything the agent needs for one
 * attempt at one story (the epic PRD, the story, the story list, the progress
 * log, the last feedback, the guidance and the quality gates). Offered stashes
 * aren't listed: the agent finds the ones left for this run and story by their
 * label in the worktree.
 */
import type {
  RalphLane,
  RalphMessage,
  RalphRun,
  RalphStory,
  Repository,
  ScmConnection,
} from "@omniralph/db";
import {
  dependencyLabel,
  initialProgress,
  normalizeRepoPath,
  uniqueCommands,
  type Epic,
  type Story,
} from "@omniralph/ralph";
import {
  RalphDescribePrPayload,
  RalphPreparePayload,
  RalphPushPayload,
  RalphRequestPayload,
  RalphStoryPayload,
  type RalphAttachment,
  type RalphJobSettings,
  type RalphStoryListItem,
} from "@omniralph/shared";
import { jobRepository } from "@/lib/scm/adapters";
import { trackerName } from "@/lib/tracker/adapters";
import type { CodingSettings } from "./coding";

/** Guidance replies passed to a story (the latest ones), as cyralph does. */
export const MAX_GUIDANCE_IN_PROMPT = 10;
const MAX_DOCUMENT_LENGTH = 200_000;

/** `feat(<ID>): <title>`, or `<ID>: <title>` for a single issue. */
export function storyCommitMessage(
  kind: RalphRun["kind"],
  identifier: string,
  title: string,
): string {
  const subject = kind === "single" ? `${identifier}: ${title}` : `feat(${identifier}): ${title}`;
  return subject.replace(/\s+/g, " ").trim().slice(0, 2000);
}

/** A long document's end (the newest part of a log), within the payload limit. */
function tailOf(text: string, max = MAX_DOCUMENT_LENGTH): string {
  return text.length > max ? text.slice(-max) : text;
}

function headOf(text: string, max = MAX_DOCUMENT_LENGTH): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * What a ralph job runs with (`settings` of every ralph payload): the repository's coding
 * instructions, and its story or request playbook's model and worktree setup command (agents
 * read those from the run spec; older agents and the worktree RPCs from here).
 */
export function jobSettings(
  repository: Pick<Repository, "codingInstructions">,
  coding: Pick<CodingSettings, "model" | "fallbackModel" | "worktreeSetupCommand">,
): RalphJobSettings {
  return {
    model: coding.model,
    setupCommand: coding.worktreeSetupCommand,
    fallbackModel: coding.fallbackModel,
    appendInstruction: repository.codingInstructions?.trim() || null,
    allowedTools: null,
    disallowedTools: null,
  };
}

/**
 * The PRD's gates for a lane's repository: the shared ones (`## Quality Gates`), then those under
 * the repository's `### <path>` heading. Another repository's gates are never included.
 */
export function prdGatesFor(
  epic: Pick<Epic, "qualityGates" | "repositoryQualityGates">,
  repository: Pick<Repository, "fullPath">,
): string[] {
  const scoped = epic.repositoryQualityGates?.[normalizeRepoPath(repository.fullPath)] ?? [];
  return uniqueCommands([...epic.qualityGates, ...scoped]);
}

/**
 * The commands a story or request job runs after its session: the lane
 * repository's checks (its Coding card's), then the PRD's gates for that
 * repository (`prdGatesFor`) when the playbook's `runPrdQualityGates` is on,
 * duplicates removed. A single issue has no PRD: only the checks.
 */
export function storyQualityGates(
  kind: RalphRun["kind"],
  epic: Pick<Epic, "qualityGates" | "repositoryQualityGates">,
  repository: Pick<Repository, "fullPath" | "checks">,
  coding: Pick<CodingSettings, "runPrdQualityGates">,
): string[] {
  const prd = kind !== "single" && coding.runPrdQualityGates ? prdGatesFor(epic, repository) : [];
  return uniqueCommands([...repository.checks, ...prd]).slice(0, 100);
}

const url = (value: string | undefined) => (value && /^https?:\/\//.test(value) ? value : null);

/** The epic's stories as the prompt lists them. */
export function storyList(epic: Epic, stories: readonly Story[]): RalphStoryListItem[] {
  return stories.map((s) => ({
    identifier: (s.identifier ?? s.storyId).slice(0, 64),
    title: s.title.slice(0, 1000),
    status: s.status,
    manual: s.manual === true,
    dependsOn: s.dependsOn.map((d) => dependencyLabel(epic, d).slice(0, 64)).slice(0, 100),
    repository: s.repo?.name.slice(0, 500) ?? null,
  }));
}

export interface StoryPayloadInput {
  /** The coding settings of the story playbook (the request playbook for requests). */
  coding: CodingSettings;
  run: RalphRun;
  /** The lane the job works in (its branch and base branch). */
  lane: Pick<RalphLane, "branch" | "baseBranch">;
  repository: Repository;
  connection: ScmConnection;
  epic: Epic;
  /** The epic's stories with the run's state applied (completed, exhausted). */
  stories: readonly Story[];
  story: Story;
  row: RalphStory;
  /** The tracker attachments in the story's scope (`payloadAttachments`). */
  attachments?: readonly RalphAttachment[];
}

export function buildStoryPayload(input: StoryPayloadInput): RalphStoryPayload {
  const { run, lane, repository, connection, epic, story, row } = input;
  const identifier = story.identifier ?? story.storyId;
  return RalphStoryPayload.parse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    settings: jobSettings(repository, input.coding),
    trackerProvider: run.trackerProvider,
    trackerName: trackerName(run.trackerProvider),
    storyId: row.id,
    attempt: row.attempts + 1,
    epic: {
      identifier: epic.identifier,
      title: epic.title.slice(0, 1000),
      kind: run.kind,
      url: url(epic.url),
      prd: run.kind === "single" ? "" : headOf(epic.description),
    },
    story: {
      identifier,
      title: story.title.slice(0, 1000),
      trackerIssueId: row.trackerIssueId,
      url: url(story.url),
      description: headOf(story.description),
    },
    stories: storyList(epic, input.stories).slice(0, 500),
    commitMessage: storyCommitMessage(run.kind, identifier, story.title),
    qualityGates: storyQualityGates(run.kind, epic, repository, input.coding),
    prdQualityGates: run.kind === "single" ? [] : prdGatesFor(epic, repository).slice(0, 50),
    progress: tailOf(run.progress || initialProgress(`${epic.identifier}: ${epic.title}`)),
    lastFeedback: row.lastFeedback ? row.lastFeedback.slice(-20_000) : null,
    guidance: run.guidance.slice(-MAX_GUIDANCE_IN_PROMPT).map((g) => g.text.slice(0, 20_000)),
    attachments: input.attachments ?? [],
  });
}

export interface DescribePrPayloadInput {
  /** The coding settings of the story playbook (the request playbook for requests). */
  coding: CodingSettings;
  run: RalphRun;
  /** The lane the job works in (its branch and base branch). */
  lane: Pick<RalphLane, "branch" | "baseBranch">;
  repository: Repository;
  connection: ScmConnection;
  epic: Epic;
  /** The run's stories (with their commits), in order. */
  rows: readonly RalphStory[];
}

/**
 * The payload of a `ralph.describe-pr` job: the epic PRD, the stories with
 * their commits, the progress log and the quality gates, for the session that
 * writes the PR/MR title and body.
 */
export function buildDescribePrPayload(input: DescribePrPayloadInput): RalphDescribePrPayload {
  const { run, lane, repository, connection, epic, rows } = input;
  return RalphDescribePrPayload.parse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    settings: jobSettings(repository, input.coding),
    epic: {
      identifier: epic.identifier,
      title: epic.title.slice(0, 1000),
      url: url(epic.url),
      prd: headOf(epic.description),
    },
    stories: rows.slice(0, 500).map((r) => ({
      identifier: r.identifier.slice(0, 64),
      title: r.title.slice(0, 1000),
      status: r.status,
      commitSha: r.commitSha,
    })),
    progress: tailOf(run.progress || initialProgress(`${epic.identifier}: ${epic.title}`)),
    qualityGates: storyQualityGates(run.kind, epic, repository, input.coding),
  });
}

export interface PushPayloadInput {
  /** The coding settings of the story playbook. */
  coding: CodingSettings;
  run: Pick<RalphRun, "id">;
  /** The lane whose branch is pushed (and its base branch). */
  lane: Pick<RalphLane, "branch" | "baseBranch">;
  repository: Repository;
  connection: ScmConnection;
  /** The run's hidden ref (`ralphHiddenRef`), holding the story commits. */
  hiddenRef: string;
}

/**
 * The trigger context of a lane's push run: the lane's branch, to push with
 * the story commits kept on the run's hidden ref.
 */
export function buildPushPayload(input: PushPayloadInput): RalphPushPayload {
  const { run, lane, repository, connection } = input;
  return RalphPushPayload.parse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    settings: jobSettings(repository, input.coding),
    hiddenRef: input.hiddenRef,
  });
}

export interface PreparePayloadInput {
  /** The coding settings of the story playbook (the request playbook for requests). */
  coding: CodingSettings;
  run: RalphRun;
  /** The lane the job works in (its branch and base branch). */
  lane: Pick<RalphLane, "branch" | "baseBranch">;
  repository: Repository;
  connection: ScmConnection;
  /** The manual story, as just re-read from the tracker (its commands as they are now). */
  story: Story;
  /** The approval: the commands hash and branch HEAD that were shown. */
  approved: { commandsHash: string; headSha: string | null };
}

/**
 * The payload of a `worktree.exec` system RPC: the manual story's commands as they
 * are now and the approval they must still match (the agent runs nothing
 * otherwise).
 */
export function buildPreparePayload(input: PreparePayloadInput): RalphPreparePayload {
  const { run, lane, repository, connection, story, approved } = input;
  return RalphPreparePayload.parse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    settings: jobSettings(repository, input.coding),
    story: { identifier: story.identifier ?? story.storyId, title: story.title.slice(0, 1000) },
    commands: story.preparation ?? [],
    commandsHash: approved.commandsHash,
    approvedHeadSha: approved.headSha,
  });
}

export interface RequestPayloadInput {
  /** The coding settings of the story playbook (the request playbook for requests). */
  coding: CodingSettings;
  run: RalphRun;
  /** The lane the requests are for (its branch, base branch and PR/MR). */
  lane: Pick<RalphLane, "branch" | "baseBranch" | "prUrl">;
  repository: Repository;
  connection: ScmConnection;
  epic: Epic;
  /** The epic's stories with the run's state applied. */
  stories: readonly Story[];
  /** The lane's pending requests (`ralph_messages`), oldest first; one `ship` ships them all. */
  requests: readonly (Pick<RalphMessage, "id" | "text"> & Partial<Pick<RalphMessage, "ship">>)[];
  /** The lane's last request conversation, when the job goes to the agent holding it. */
  resumeSessionId: string | null;
  /** Every tracker attachment of the run (`payloadAttachments`). */
  attachments?: readonly RalphAttachment[];
  /** The run's hidden ref, when the lane's story commits may only be there (`pushTiming: end`). */
  hiddenRef?: string;
}

/**
 * The payload of a `ralph.request` job: a lane's pending requests with the
 * epic as context (status, stories, PR/MR, progress log, quality gates) and
 * the repository's `historyRewrite`. A `/ship` among them makes it a ship job.
 */
export function buildRequestPayload(input: RequestPayloadInput): RalphRequestPayload {
  const { run, lane, repository, connection, epic } = input;
  const requests = input.requests.slice(0, 50);
  return RalphRequestPayload.parse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    settings: jobSettings(repository, input.coding),
    source: run.origin === "chat" ? "chat" : "tracker",
    trackerProvider: run.trackerProvider,
    trackerName: trackerName(run.trackerProvider),
    epic: {
      identifier: epic.identifier,
      title: epic.title.slice(0, 1000),
      kind: run.kind,
      url: url(epic.url),
      prd: run.kind === "single" ? "" : headOf(epic.description),
    },
    stories: storyList(epic, input.stories).slice(0, 500),
    requests: requests.map((r) => ({ id: r.id, text: r.text.slice(0, 20_000) })),
    prUrl: url(lane.prUrl ?? undefined),
    progress: tailOf(run.progress || initialProgress(`${epic.identifier}: ${epic.title}`)),
    qualityGates: storyQualityGates(run.kind, epic, repository, input.coding),
    historyRewrite: repository.historyRewrite,
    resumeSessionId: input.resumeSessionId,
    attachments: input.attachments ?? [],
    ship: requests.some((r) => r.ship === true),
    ...(input.hiddenRef && { hiddenRef: input.hiddenRef }),
  });
}
