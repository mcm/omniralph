/**
 * The payload of a `ralph.story` job: everything the agent needs for one
 * attempt at one story (the epic PRD, the story, the story list, the progress
 * log, the last feedback, the guidance and the quality gates). Offered stashes
 * aren't listed: the agent finds the ones left for this run and story by their
 * label in the worktree.
 */
import type { RalphRun, RalphStory, Repository, ScmConnection } from "@omniralph/db";
import {
  dependencyLabel,
  initialProgress,
  uniqueCommands,
  type Epic,
  type Story,
} from "@omniralph/ralph";
import { RalphStoryPayload, type RalphStoryListItem } from "@omniralph/shared";
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
  repository: Repository;
  connection: ScmConnection;
  epic: Epic;
  /** The epic's stories with the run's state applied (completed, exhausted). */
  stories: readonly Story[];
  story: Story;
  row: RalphStory;
}

export function buildStoryPayload(input: StoryPayloadInput): RalphStoryPayload {
  const { run, repository, connection, epic, story, row } = input;
  const identifier = story.identifier ?? story.storyId;
  return RalphStoryPayload.parse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: run.branch,
    baseBranch: run.baseBranch,
    settings: {
      model: repository.ralphSettings.model || null,
      setupCommand: repository.ralphSettings.setupCommand || null,
    },
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
    qualityGates: uniqueCommands(epic.qualityGates).slice(0, 50),
    progress: tailOf(run.progress || initialProgress(`${epic.identifier}: ${epic.title}`)),
    lastFeedback: row.lastFeedback ? row.lastFeedback.slice(-20_000) : null,
    guidance: run.guidance.slice(-MAX_GUIDANCE_IN_PROMPT).map((g) => g.text.slice(0, 20_000)),
  });
}
