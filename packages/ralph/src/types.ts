/**
 * Core ralph domain types (ported from cyralph).
 *
 * An epic is a named body of work split into small, independently completable user stories
 * with priorities and dependencies. In a tracker an epic is a parent work item and each story
 * is a child work item; priority, order, state and dependencies come from the tracker's own fields.
 */

export type StoryStatus = "open" | "in_progress" | "completed" | "cancelled";

export interface Story {
  /** Stable key used for dependency resolution within an epic (the work item's tracker ID, or story id for in-memory stories). */
  key: string;
  /** How the story is referred to: its work item's identifier (e.g. "ENG-12"), or the PRD story id for in-memory stories. */
  storyId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /**
   * Sort rank, lower = sooner: the tracker priority 1 (Urgent) … 4 (Low), 5 for no priority; or the
   * PRD priority. A rank of 0 or less (the tracker's "No priority") sorts last.
   */
  priority: number;
  /** Tie-break after priority: the story's position among the epic's children in the tracker (`subIssueSortOrder`). */
  sortOrder?: number;
  /** Keys of stories (or `external:<work item id>` markers) that must be completed first. */
  dependsOn: string[];
  status: StoryStatus;
  notes?: string;
  /** A manual step done by a person (labelled with a manual label): never given to the agent. */
  manual?: boolean;
  /** Out of attempts: never selected again until someone resets it (e.g. with new guidance). */
  exhausted?: boolean;
  /**
   * Why the story is treated as manual although it isn't labelled so, e.g. it routes to a
   * different repository than the epic's.
   */
  elsewhere?: string;
  /**
   * Set when the story's own routing signals send it to another repository than the epic's: it's
   * worked in that repository's lane. `name` is the repository's path, `routedBy` how it matched.
   */
  repo?: { id: string; name: string; routedBy: string };
  /**
   * Preparation commands from the ```cyralph-prepare blocks of a manual story's description, one per
   * command, in order. Run only with a person's approval; never set on non-manual stories.
   */
  preparation?: string[];
  /** The story issue's full description as written. */
  sourceText?: string;
  /** The story work item's routing fields: its tracker project, team and labels. */
  projectName?: string;
  teamKey?: string;
  labels?: string[];
  /** Present when the story is backed by a work item in a tracker. */
  issueId?: string;
  /** A Fix (it has one of the tracker's fix labels) or a Story (new work); absent: a Story. */
  kind?: "fix" | "story";
  /** The epic requirements the story owns, from its `Covers:` line (`FR-2`), in order. */
  covers?: string[];
  identifier?: string;
  url?: string;
}

export type EpicKind =
  /** Parent issue with sub-issues as stories. */
  | "children"
  /** A PRD (markdown or prd.json) embedded in the issue description, not yet split into issues. */
  | "prd"
  /** A plain issue with no PRD structure: treated as a one-story epic. */
  | "single";

export interface Epic {
  kind: EpicKind;
  issueId: string;
  identifier: string;
  title: string;
  description: string;
  url?: string;
  teamId?: string;
  /** The epic work item's project and team, which its stories inherit for routing unless they differ. */
  projectName?: string;
  teamKey?: string;
  branchName: string;
  /** Shell commands the PRD requires to pass for every story, in every repository. */
  qualityGates: string[];
  /**
   * Commands the PRD requires only in one repository (`### <repository>` under Quality Gates),
   * keyed by `normalizeRepoPath` of the repository's full path; absent when there are none.
   */
  repositoryQualityGates?: Record<string, string[]>;
  /** A new-format epic's requirements (`## Requirements`); absent for a legacy PRD or a plain issue. */
  requirements?: Array<{ id: string; text: string }>;
  stories: Story[];
  /** Open work items outside the epic that block one of its stories: tracker ID -> identifier (e.g. "ENG-99"). */
  externalIssues?: Record<string, string>;
}

/** Story dependency marker for a blocker outside the epic: `external:<work item id>`. */
export const EXTERNAL_DEP_PREFIX = "external:";

export function externalIdOf(dep: string): string | undefined {
  return dep.startsWith(EXTERNAL_DEP_PREFIX) ? dep.slice(EXTERNAL_DEP_PREFIX.length) : undefined;
}

/** Human label for a dependency: the story id within the epic, or the external issue identifier. */
export function dependencyLabel(epic: Epic, dep: string): string {
  const ext = externalIdOf(dep);
  if (ext) return epic.externalIssues?.[ext] ?? ext;
  return epic.stories.find((s) => s.key === dep)?.storyId ?? dep;
}
