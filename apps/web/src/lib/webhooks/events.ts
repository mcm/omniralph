import { z } from "zod";

/**
 * A PR/MR event that may trigger a review: `open` covers opened, reopened and
 * ready-for-review (the `onOpen` trigger), `push` new commits (`onPush`).
 */
export interface ChangeRequestEvent {
  kind: "open" | "push";
  number: number;
  draft: boolean;
  headSha: string;
  /** Target-branch commit to diff against (GitLab events carry none; it's looked up). */
  baseSha: string | null;
  title: string;
  description: string | null;
  /** Author username (GitLab events only carry the acting user; it's looked up). */
  author: string | null;
}

const GitHubPullRequestEvent = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    state: z.string(),
    draft: z.boolean().optional(),
    title: z.string(),
    body: z.string().nullish(),
    user: z.object({ login: z.string() }).nullish(),
    head: z.object({ sha: z.string().min(1) }),
    base: z.object({ sha: z.string().min(1) }),
  }),
});

const GITHUB_ACTIONS: Record<string, ChangeRequestEvent["kind"]> = {
  opened: "open",
  reopened: "open",
  ready_for_review: "open",
  synchronize: "push",
};

/** The review-triggering event of a GitHub delivery (`X-GitHub-Event`), or null. */
export function parseGitHubEvent(
  eventName: string | null,
  body: unknown,
): ChangeRequestEvent | null {
  if (eventName !== "pull_request") return null;
  const parsed = GitHubPullRequestEvent.safeParse(body);
  if (!parsed.success) return null;
  const { action, pull_request: pr } = parsed.data;
  const kind = GITHUB_ACTIONS[action];
  if (!kind || pr.state !== "open") return null;
  return {
    kind,
    number: pr.number,
    draft: pr.draft ?? false,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    title: pr.title,
    description: pr.body ?? null,
    author: pr.user?.login ?? null,
  };
}

const DraftChange = z.object({ previous: z.boolean().nullish(), current: z.boolean().nullish() });

const GitLabMergeRequestEvent = z.object({
  object_kind: z.literal("merge_request"),
  object_attributes: z.object({
    iid: z.number().int().positive(),
    action: z.string().optional(),
    state: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    oldrev: z.string().nullish(),
    last_commit: z.object({ id: z.string().min(1) }),
  }),
  changes: z
    .object({ draft: DraftChange.optional(), work_in_progress: DraftChange.optional() })
    .optional(),
});

function readyForReview(changes: z.infer<typeof GitLabMergeRequestEvent>["changes"]): boolean {
  const change = changes?.draft ?? changes?.work_in_progress;
  return change?.previous === true && change.current === false;
}

/** The review-triggering event of a GitLab delivery (`X-Gitlab-Event`), or null. */
export function parseGitLabEvent(
  eventName: string | null,
  body: unknown,
): ChangeRequestEvent | null {
  if (eventName !== "Merge Request Hook") return null;
  const parsed = GitLabMergeRequestEvent.safeParse(body);
  if (!parsed.success) return null;
  const { object_attributes: mr, changes } = parsed.data;
  if (mr.state !== "opened") return null;
  let kind: ChangeRequestEvent["kind"] | null = null;
  if (mr.action === "open" || mr.action === "reopen") kind = "open";
  else if (mr.action === "update" && mr.oldrev) kind = "push";
  else if (mr.action === "update" && readyForReview(changes)) kind = "open";
  if (!kind) return null;
  return {
    kind,
    number: mr.iid,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    headSha: mr.last_commit.id,
    baseSha: null,
    title: mr.title,
    description: mr.description ?? null,
    author: null,
  };
}

/** Provider repository/project ID of a delivery body, if any. */
export function webhookRepositoryId(provider: "github" | "gitlab", body: unknown): string | null {
  const schema =
    provider === "github"
      ? z.object({ repository: z.object({ id: z.number().int() }) })
      : z.object({ project: z.object({ id: z.number().int() }) });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return null;
  return String("repository" in parsed.data ? parsed.data.repository.id : parsed.data.project.id);
}

/** GitHub App installation ID of a delivery body, if any. */
export function githubInstallationId(body: unknown): string | null {
  const parsed = z.object({ installation: z.object({ id: z.number().int() }) }).safeParse(body);
  return parsed.success ? String(parsed.data.installation.id) : null;
}
