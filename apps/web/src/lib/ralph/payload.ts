/**
 * The payload of a `ralph.story` job: everything the agent needs for one
 * attempt at one story (the epic PRD, the story, the story list, the progress
 * log, the last feedback, the guidance and the quality gates). Offered stashes
 * aren't listed: the agent finds the ones left for this run and story by their
 * label in the worktree.
 */
import type { RalphLane, RalphRun, RalphStory, Repository, ScmConnection } from "@omniralph/db";
import {
  dependencyLabel,
  initialProgress,
  uniqueCommands,
  type Epic,
  type Story,
} from "@omniralph/ralph";
import {
  parseRalphSettings,
  RalphDescribePrPayload,
  RalphPreparePayload,
  RalphStoryPayload,
  type RalphJobSettings,
  type RalphStoryListItem,
} from "@omniralph/shared";
import { jobRepository } from "@/lib/scm/adapters";

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

/** The repository's ralph settings a job runs with (`settings` of every ralph payload). */
export function jobSettings(repository: Pick<Repository, "ralphSettings">): RalphJobSettings {
  const settings = parseRalphSettings(repository.ralphSettings);
  return {
    model: settings.model || null,
    setupCommand: settings.setupCommand,
    fallbackModel: settings.fallbackModel,
    appendInstruction: settings.appendInstruction,
    allowedTools: settings.allowedTools,
    disallowedTools: settings.disallowedTools,
  };
}

/**
 * A story's quality gates (cyralph's `verifyCommands` of `runStory`): the
 * repository's `verifyCommands`, then the PRD's gates when
 * `runPrdQualityGates` is on, duplicates removed. A single issue has no PRD:
 * only `verifyCommands`.
 */
export function storyQualityGates(
  kind: RalphRun["kind"],
  epic: Pick<Epic, "qualityGates">,
  repository: Pick<Repository, "ralphSettings">,
): string[] {
  const settings = parseRalphSettings(repository.ralphSettings);
  const prd = kind !== "single" && settings.runPrdQualityGates ? epic.qualityGates : [];
  return uniqueCommands([...settings.verifyCommands, ...prd]).slice(0, 100);
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
  }));
}

export interface StoryPayloadInput {
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
    settings: jobSettings(repository),
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
      linearIssueId: row.linearIssueId,
      url: url(story.url),
      description: headOf(story.description),
    },
    stories: storyList(epic, input.stories).slice(0, 500),
    commitMessage: storyCommitMessage(run.kind, identifier, story.title),
    qualityGates: storyQualityGates(run.kind, epic, repository),
    prdQualityGates: run.kind === "single" ? [] : uniqueCommands(epic.qualityGates).slice(0, 50),
    progress: tailOf(run.progress || initialProgress(`${epic.identifier}: ${epic.title}`)),
    lastFeedback: row.lastFeedback ? row.lastFeedback.slice(-20_000) : null,
    guidance: run.guidance.slice(-MAX_GUIDANCE_IN_PROMPT).map((g) => g.text.slice(0, 20_000)),
  });
}

export interface DescribePrPayloadInput {
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
    settings: jobSettings(repository),
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
    qualityGates: storyQualityGates(run.kind, epic, repository),
  });
}

export interface PreparePayloadInput {
  run: RalphRun;
  /** The lane the job works in (its branch and base branch). */
  lane: Pick<RalphLane, "branch" | "baseBranch">;
  repository: Repository;
  connection: ScmConnection;
  /** The manual story, as just re-read from Linear (its commands as they are now). */
  story: Story;
  /** The approval: the commands hash and branch HEAD that were shown. */
  approved: { commandsHash: string; headSha: string | null };
}

/**
 * The payload of a `ralph.prepare` job: the manual story's commands as they
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
    settings: jobSettings(repository),
    story: { identifier: story.identifier ?? story.storyId, title: story.title.slice(0, 1000) },
    commands: story.preparation ?? [],
    commandsHash: approved.commandsHash,
    approvedHeadSha: approved.headSha,
  });
}
