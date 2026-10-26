import { CONVENTIONS_PATH, diff, findingHunks, showFile } from "@omniralph/engine";
import type { JobRepository } from "@omniralph/shared";
import { z } from "zod";
import type { RepoCache } from "../workspace/repoCache.js";

/** The variables a `query` task type provides to its prompt template (see the tasks catalog). */
export interface QueryVariables {
  /** The question or request, from the trigger context. */
  question: string | null;
  /** The finding's diff hunk, when the trigger context has a finding with base/head commits. */
  hunk: string | null;
  /** The checkout's `CLAUDE.md`. */
  conventions: string | null;
  /** Whether the working directory holds a checkout of the run's ref. */
  checkout: boolean;
}

const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** What the trigger context's `finding` needs for its hunk to be computed. */
const HunkFinding = z.object({
  path: z.string().min(1),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  baseSha: Sha,
  headSha: Sha,
});

/** The trigger context's `question`, or null when it has none. */
export function questionVariable(context: Record<string, unknown>): string | null {
  const question = context.question;
  return typeof question === "string" && question.trim() !== "" ? question : null;
}

export interface VariableGitOptions {
  /** The agent's environment for git (`ctx.env()`). */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

/**
 * The hunks of `git diff base...head -- path` around the trigger context's
 * finding, or null when there's no such finding (or no repository), its
 * commits can't be fetched, or no hunk overlaps its lines.
 */
export async function hunkVariable(
  repos: RepoCache,
  repository: JobRepository | null,
  context: Record<string, unknown>,
  git: VariableGitOptions,
): Promise<string | null> {
  const parsed = HunkFinding.safeParse(context.finding);
  if (!repository || !parsed.success) return null;
  const finding = parsed.data;
  try {
    await repos.sync(repository, { ...git, shas: [finding.baseSha, finding.headSha] });
    const text = await diff(
      repos.repoDir(repository),
      `${finding.baseSha}...${finding.headSha}`,
      repos.gitEnv(git.env),
      [finding.path],
    );
    return findingHunks(text, finding);
  } catch {
    git.signal.throwIfAborted();
    return null;
  }
}

/** The checkout's `CLAUDE.md` at `sha`, trimmed; null without one (or a blank one, or without a checkout). */
export async function conventionsVariable(
  checkout: { path: string; sha: string } | null,
  gitEnv: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!checkout) return null;
  const text = (await showFile(checkout.path, checkout.sha, CONVENTIONS_PATH, gitEnv))?.trim();
  return text ? text : null;
}
