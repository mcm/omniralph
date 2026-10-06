/**
 * Replies in a run's agent session and the preparation of manual stories (ported from cyralph's
 * `linear/webhook.ts` and `engine/preparation.ts`): what a reply asks for, and the approval of a
 * manual story's ```cyralph-prepare commands, run only after a person says "Run it".
 */
import { createHash } from "node:crypto";
import { isStoryDone, sortStories } from "./selection.js";
import type { Story } from "./types.js";

/** "stop", "stop working", "Stop session." (or Linear's Stop button, the `stop` signal). */
export function isStopRequest(reply: { body: string; signal?: string | undefined }): boolean {
  return reply.signal === "stop" || /^\s*stop(\s+session|\s+working)?[\s.!?]*$/i.test(reply.body);
}

/** "start anyway", "ignore the blockers", "go ahead anyway"… */
export function isStartAnywayRequest(reply: string): boolean {
  return /\b(start|go|proceed|run|work on it|go ahead)\s+anyway\b|\bignore\s+(the\s+)?block(er|ers|ing|ed)?\b/i.test(
    reply,
  );
}

export const PREPARATION_RUN = "Run it";
export const PREPARATION_MYSELF = "I'll do it myself";
export const PREPARATION_LATER = "Not yet";
export const PREPARATION_OPTIONS = [
  PREPARATION_RUN,
  PREPARATION_MYSELF,
  PREPARATION_LATER,
] as const;
export type PreparationAnswer = (typeof PREPARATION_OPTIONS)[number];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * A reply to the pending preparation question: an option's value (what Linear sends for a picked
 * option) or its 1-based number. Anything else isn't an answer.
 */
export function matchPreparationAnswer(reply: string): PreparationAnswer | undefined {
  const text = norm(reply);
  if (/^[123]$/.test(text)) return PREPARATION_OPTIONS[Number(text) - 1];
  return PREPARATION_OPTIONS.find((o) => norm(o) === text);
}

/** A reply asking to offer a manual story's preparation again, even after it ran or was declined. */
export function isRerunPreparationRequest(reply: string): boolean {
  return norm(reply) === "rerun preparation";
}

/** SHA-256 (hex) of a story's commands, so an approval is bound to the commands that were shown. */
export function preparationHash(commands: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
}

/** The most commands one `ralph.prepare` job runs. */
export const MAX_PREPARATION_COMMANDS = 50;
/** The longest command a `ralph.prepare` job runs. */
export const MAX_PREPARATION_COMMAND_LENGTH = 4000;

/** Whether a `ralph.prepare` job can run these commands (as many and as long as its payload allows). */
export function isRunnablePreparation(commands: readonly string[]): boolean {
  return (
    commands.length > 0 &&
    commands.length <= MAX_PREPARATION_COMMANDS &&
    commands.every((c) => c.length <= MAX_PREPARATION_COMMAND_LENGTH)
  );
}

/**
 * Manual stories whose preparation can be offered now, in story order: open, with commands a
 * `ralph.prepare` job can run, every blocker done, and not in `handled` (story issue IDs, or keys)
 * yet. A story with more (or longer) commands than that is left to a person.
 */
export function eligiblePreparations(
  stories: readonly Story[],
  handled: ReadonlySet<string> = new Set(),
): Story[] {
  const byKey = new Map(stories.map((s) => [s.key, s]));
  return sortStories([...stories]).filter(
    (s) =>
      s.manual &&
      isRunnablePreparation(s.preparation ?? []) &&
      !isStoryDone(s) &&
      !handled.has(s.issueId ?? s.key) &&
      s.dependsOn.every((d) => {
        const dep = byKey.get(d);
        // Outside blockers stay in `dependsOn` only while they are open.
        return dep ? isStoryDone(dep) : false;
      }),
  );
}

/** `text` in a Markdown code block that no backtick run inside it can close. */
export function fenced(text: string, info = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/**
 * The body of the approval picker. `headSha` is the branch's last story commit the approval is
 * bound to (null: no story committed yet, so the branch is its base).
 */
export function preparationQuestion(input: {
  story: Pick<Story, "storyId" | "title">;
  branch: string;
  headSha: string | null;
  commands: readonly string[];
  lead?: string | undefined;
}): string {
  const { story, branch, headSha, commands, lead } = input;
  const name = `**${story.storyId}: ${story.title}**`;
  const at = headSha ? `at \`${headSha.slice(0, 10)}\`` : "(no story committed yet)";
  return [
    lead,
    `${name} is a manual step with preparation commands. Should I run them now, in the epic's worktree on \`${branch}\` ${at}?`,
    fenced(commands.join("\n"), "sh"),
    `**${PREPARATION_RUN}** runs them one at a time and stops at the first failure; **${PREPARATION_MYSELF}** leaves them to you; **${PREPARATION_LATER}** keeps the question open. Either way, the rest of ${story.storyId} stays with a person, who marks it done.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
