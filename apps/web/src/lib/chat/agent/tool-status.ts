/**
 * What Om is doing while it uses a tool, as the plain sentence a web chat shows under the
 * reply (design rule 4: never a tool name). Every tool of `chatTools` has one (a test
 * enumerates them).
 */

/** The status of a tool without a sentence of its own. */
export const UNKNOWN_TOOL_STATUS = "Working on it";

/** A repo's short name for a sentence: the last segment of its path (an ID says nothing). */
function repoName(input: unknown): string | null {
  const repository =
    input && typeof input === "object" ? (input as { repository?: unknown }).repository : null;
  if (typeof repository !== "string") return null;
  const path = repository.trim().replace(/\/+$/, "");
  if (!path || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path)) {
    return null;
  }
  return path.split("/").at(-1) || null;
}

const STATUSES: Record<string, (input: unknown) => string> = {
  list_ralph_runs: () => "Looking at runs",
  get_ralph_run: () => "Looking at a run",
  get_run_status: () => "Checking on the run",
  list_reviews: () => "Looking at reviews",
  get_review: () => "Looking at a review",
  list_jobs: () => "Looking at what the agents are running",
  list_agents: () => "Looking at the agents",
  list_repositories: () => "Looking at the repos",
  ask_about_code: (input) => {
    const repo = repoName(input);
    return repo ? `Asking an agent to read ${repo}` : "Asking an agent to read the code";
  },
  start_work: (input) => {
    const repo = repoName(input);
    return repo ? `Starting a request in ${repo}` : "Starting a request";
  },
  reply_to_run: () => "Passing your message to the run",
  answer_run_permission: () => "Answering the run's approval request",
  answer_run_cleanup: () => "Answering the run's cleanup question",
  send_ralph_guidance: () => "Sending guidance to a run",
  draft_tracker_issue: () => "Drafting a work item",
  delegate_tracker_issue: () => "Handing the work item to Om",
  draft_request: () => "Drafting a request",
};

/** The sentence for a call of `toolName` with `input`. */
export function toolStatus(toolName: string, input: unknown): string {
  const status = Object.hasOwn(STATUSES, toolName) ? STATUSES[toolName] : undefined;
  return status ? status(input) : UNKNOWN_TOOL_STATUS;
}

/** Whether `toolName` has a sentence of its own. */
export const hasToolStatus = (toolName: string): boolean => Object.hasOwn(STATUSES, toolName);
