/**
 * Sanitizes the agent-written title and body of a ralph run's PR/MR before
 * the control panel posts them. The text comes from a Claude session that
 * read the repository and the Linear epic (untrusted input), so it goes
 * through the review sanitizer: markdown and links to the repository's code
 * host are kept; other links, raw HTML and images are neutralized; and
 * `@mentions` are kept only for users of the repository, so a description
 * can't ping (or spam) outsiders.
 */
import { mentionedNames, sanitizeCapped, sanitizeTitle } from "@/lib/review/sanitize";

/** Below GitHub's 65,536-character limit, leaving room for a footer. */
export const MAX_PULL_REQUEST_BODY_CHARS = 60_000;

export interface PullRequestTextContext {
  /** Hosts whose links stay clickable: the repo's code host, e.g. `github.com`. */
  allowedHosts: readonly string[];
  /**
   * Whether `username` is a user of the repository (e.g. via
   * `ScmAdapter.hasWriteAccess`). A failed check counts as "no".
   */
  isRepositoryUser: (username: string) => Promise<boolean>;
}

export interface PullRequestText {
  title: string;
  body: string;
}

/** The mentioned usernames that are users of the repository (teams and groups never are). */
async function repositoryMentions(
  text: string,
  isRepositoryUser: PullRequestTextContext["isRepositoryUser"],
) {
  const users = mentionedNames(text).filter((name) => !name.includes("/"));
  const checks = await Promise.all(
    users.map(async (name) => ((await isRepositoryUser(name).catch(() => false)) ? name : null)),
  );
  return checks.filter((name): name is string => name !== null);
}

/** The PR/MR title (one line) and body (capped), ready to post. */
export async function sanitizePullRequestText(
  text: PullRequestText,
  ctx: PullRequestTextContext,
): Promise<PullRequestText> {
  const allowedMentions = await repositoryMentions(
    `${text.title}\n${text.body}`,
    ctx.isRepositoryUser,
  );
  const sanitizeContext = { allowedHosts: ctx.allowedHosts, allowedMentions };
  return {
    title: sanitizeTitle(text.title, sanitizeContext),
    body: sanitizeCapped(text.body, sanitizeContext, MAX_PULL_REQUEST_BODY_CHARS),
  };
}
