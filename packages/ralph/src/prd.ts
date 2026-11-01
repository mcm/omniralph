/**
 * Parse ralph-tui PRDs from text: either the markdown PRD produced by the
 * `ralph-tui-prd` skill, or a `prd.json` document (optionally inside a fenced code block).
 */

/** Priority of a PRD story that doesn't give one (1 = highest). */
export const DEFAULT_PRD_PRIORITY = 3;

export interface PrdStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  dependsOn: string[];
  passes: boolean;
  notes?: string;
  /** A step for a person (`**Labels:** manual`, or `manual: true` in prd.json): filed with the manual label. */
  manual?: boolean;
}

export interface ParsedPrd {
  name: string;
  description: string;
  branchName?: string;
  /** Shared quality gates (see `parseRepositoryQualityGates`). */
  qualityGates: string[];
  /** Quality gates scoped to a repository, keyed by `normalizeRepoPath`; absent when there are none. */
  repositoryQualityGates?: Record<string, string[]>;
  stories: PrdStory[];
  source: "markdown" | "json";
}

const STORY_HEADER =
  /^(#{2,4})\s+((?:US|[A-Z]{1,10})-\d+(?:\.\d+)*|Feature\s+\d+\.\d+)\s*:\s*(.+)$/i;
const ANY_HEADER = /^(#{1,6})\s+/;
const FIELD_LABEL =
  /^\*\*(Description|Acceptance Criteria|Priority|Depends on|Dependencies|Labels|Notes):\*\*\s*(.*)$/i;

/** Strip `[PRD]...[/PRD]` wrappers emitted by the ralph-tui-prd skill. */
function unwrap(text: string): string {
  const m = /\[PRD\]([\s\S]*?)\[\/PRD\]/.exec(text);
  return (m?.[1] ?? text).replace(/\r\n/g, "\n");
}

/** A PRD's quality gates: shared by every repository, plus the ones scoped to a repository. */
export interface QualityGates {
  /** Bullets before any repository heading (or under a heading that isn't a repository path). */
  shared: string[];
  /** Bullets under `### <repository full path>`, keyed by `normalizeRepoPath` of the heading. */
  byRepository: Record<string, string[]>;
}

/** A repository full path (`group/name`, subgroups allowed), as `normalizeRepoPath` gives it. */
const REPO_PATH = /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/;

/** The repository a `###` heading under Quality Gates names (normalized), if it is one. */
function gateHeadingRepository(heading: string): string | undefined {
  const text = heading
    .trim()
    .replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, "$1") // trackers escape markdown characters
    .replace(/:$/, "")
    .trim()
    .replace(/^`([^`]+)`$/, "$1");
  const path = normalizeRepoPath(text);
  return REPO_PATH.test(path) ? path : undefined;
}

/**
 * Extract commands from a Quality Gates section: the first backticked span of each bullet.
 * Bullets under `### <repository full path>` (optionally backticked) apply to that repository
 * only; every other bullet, including those under any other `###` heading, is shared.
 */
export function parseRepositoryQualityGates(markdown: string): QualityGates {
  const gates: QualityGates = { shared: [], byRepository: {} };
  const text = unwrap(markdown);
  const m = /^##\s+Quality Gates\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(text);
  if (!m?.[1]) return gates;
  let current = gates.shared;
  for (const line of m[1].split("\n")) {
    const heading = /^\s*#{3,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      const repository = gateHeadingRepository(heading);
      current = repository ? (gates.byRepository[repository] ??= []) : gates.shared;
      continue;
    }
    // Only the first backticked span of a bullet is the command: "- `pnpm lint` - Linting"
    const cmd = /^\s*[-*]\s+`([^`]+)`/.exec(line)?.[1]?.trim();
    if (cmd && !current.includes(cmd)) current.push(cmd);
  }
  return gates;
}

/** The PRD's shared quality gates (see `parseRepositoryQualityGates` for the scoped ones). */
export function parseQualityGates(markdown: string): string[] {
  return parseRepositoryQualityGates(markdown).shared;
}

/** A PRD's `qualityGates` and `repositoryQualityGates` (only when some gate is scoped). */
export function prdQualityGates(
  markdown: string,
): Pick<ParsedPrd, "qualityGates" | "repositoryQualityGates"> {
  const { shared, byRepository } = parseRepositoryQualityGates(markdown);
  return {
    qualityGates: shared,
    ...(Object.keys(byRepository).length > 0 && { repositoryQualityGates: byRepository }),
  };
}

/** The branch named by a `> Branch: <name>` line (optionally backticked), if any. */
export function parseBranchLine(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return /^>\s*Branch:\s*`?([^`\n]+)`?/m.exec(unwrap(text))?.[1]?.trim() || undefined;
}

/** A repository path for comparison: lower case, no surrounding slashes, no `.git` suffix. */
export function normalizeRepoPath(path: string): string {
  return path
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "");
}

function parseStorySection(id: string, title: string, lines: string[]): PrdStory {
  const description: string[] = [];
  const criteria: string[] = [];
  let priority = DEFAULT_PRD_PRIORITY;
  let dependsOn: string[] = [];
  let notes: string | undefined;
  let manual = false;
  let mode: "description" | "criteria" | "other" = "description";

  for (const raw of lines) {
    const line = raw.trimEnd();
    const field = FIELD_LABEL.exec(line.trim());
    if (field?.[1]) {
      const label = field[1].toLowerCase();
      const rest = field[2]?.trim() ?? "";
      if (label === "description") {
        mode = "description";
        if (rest) description.push(rest);
      } else if (label === "acceptance criteria") {
        mode = "criteria";
      } else if (label === "priority") {
        const p = /P?(\d+)/i.exec(rest)?.[1];
        if (p) priority = Number.parseInt(p, 10);
        mode = "other";
      } else if (label === "depends on" || label === "dependencies") {
        dependsOn = parseDependsOn(rest);
        mode = "other";
      } else if (label === "labels") {
        manual = hasManualLabel(rest.split(/[,\s]+/));
        mode = "other";
      } else if (label === "notes") {
        notes = rest || undefined;
        mode = "other";
      } else {
        mode = "other";
      }
      continue;
    }
    if (mode === "criteria") {
      const item = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)?.[1];
      if (item) criteria.push(item.trim());
    } else if (mode === "description") {
      description.push(line);
    }
  }
  return {
    id,
    title: title.trim(),
    description: description.join("\n").trim(),
    acceptanceCriteria: criteria,
    priority,
    dependsOn,
    passes: false,
    notes,
    ...(manual && { manual: true }),
  };
}

/** Whether a PRD story's labels mark it as a manual step. */
function hasManualLabel(labels: readonly unknown[]): boolean {
  return labels.some(
    (l) => typeof l === "string" && l.trim().replace(/^`|`$/g, "").toLowerCase() === "manual",
  );
}

function parseDependsOn(text: string): string[] {
  if (!text || /^(none|n\/a|-)$/i.test(text.trim())) return [];
  return [...text.matchAll(/(?:US|[A-Z]{1,10})-\d+(?:\.\d+)*/gi)].map((m) => m[0].toUpperCase());
}

export function parsePrdMarkdown(markdown: string): ParsedPrd | null {
  const text = unwrap(markdown);
  const lines = text.split("\n");
  const stories: PrdStory[] = [];
  let current: { id: string; title: string; level: number; lines: string[] } | null = null;
  const flush = () => {
    if (current) stories.push(parseStorySection(current.id, current.title, current.lines));
    current = null;
  };

  for (const line of lines) {
    const story = STORY_HEADER.exec(line);
    if (story?.[1] && story[2] && story[3]) {
      flush();
      current = { id: story[2].toUpperCase(), title: story[3], level: story[1].length, lines: [] };
      continue;
    }
    const header = ANY_HEADER.exec(line);
    if (current && header?.[1] && header[1].length <= current.level) {
      flush();
      continue;
    }
    current?.lines.push(line);
  }
  flush();
  if (stories.length === 0) return null;

  const name = /^#\s+(?:PRD:\s*)?(.+)$/m.exec(text)?.[1]?.trim() ?? "Untitled PRD";
  const overview = /^##\s+(?:Overview|Introduction)\s*\n+([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/m
    .exec(text)?.[1]
    ?.trim();
  return {
    name,
    description: overview ?? "",
    branchName: parseBranchLine(text),
    ...prdQualityGates(text),
    stories,
    source: "markdown",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a ralph-tui prd.json document (schema from ralph-tui's json tracker). */
export function parsePrdJson(input: string | unknown): ParsedPrd | null {
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isRecord(data) || !Array.isArray(data.userStories)) return null;
  const stories: PrdStory[] = [];
  for (const s of data.userStories) {
    if (!isRecord(s) || typeof s.id !== "string" || typeof s.title !== "string") continue;
    stories.push({
      id: s.id,
      title: s.title,
      description: typeof s.description === "string" ? s.description : "",
      acceptanceCriteria: Array.isArray(s.acceptanceCriteria)
        ? s.acceptanceCriteria.map(String)
        : [],
      priority: typeof s.priority === "number" ? s.priority : DEFAULT_PRD_PRIORITY,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
      passes: s.passes === true,
      notes: typeof s.notes === "string" && s.notes ? s.notes : undefined,
      ...((s.manual === true || (Array.isArray(s.labels) && hasManualLabel(s.labels))) && {
        manual: true,
      }),
    });
  }
  if (stories.length === 0) return null;
  const name =
    typeof data.name === "string"
      ? data.name
      : typeof data.project === "string"
        ? data.project
        : "Untitled PRD";
  return {
    name,
    description: typeof data.description === "string" ? data.description : "",
    branchName: typeof data.branchName === "string" ? data.branchName : undefined,
    // prd.json bakes quality gates into each story's acceptance criteria.
    qualityGates: [],
    stories,
    source: "json",
  };
}

/**
 * Find a PRD anywhere in an issue description: a fenced ```json prd.json block takes precedence
 * over markdown user stories. Null when the text has no user stories (it isn't a PRD).
 *
 * The `> Branch:` line and `## Quality Gates` are read from the whole text, so a prd.json block's
 * surrounding markdown can still name them.
 */
export function parsePrd(text: string | undefined | null): ParsedPrd | null {
  if (!text?.trim()) return null;
  const prd = findPrd(text);
  if (!prd) return null;
  return {
    ...prd,
    branchName: prd.branchName || parseBranchLine(text),
    ...(prd.qualityGates.length > 0 || prd.repositoryQualityGates ? {} : prdQualityGates(text)),
  };
}

function findPrd(text: string): ParsedPrd | null {
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    const prd = m[1] ? parsePrdJson(m[1]) : null;
    if (prd) return prd;
  }
  const whole = text.trim();
  if (whole.startsWith("{")) {
    const prd = parsePrdJson(whole);
    if (prd) return prd;
  }
  return parsePrdMarkdown(text);
}
