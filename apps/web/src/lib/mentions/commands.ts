/**
 * `@bot` mention commands in PR/MR threads (on GitLab the connection's bot
 * username, otherwise `BOT_HANDLE`, default `omniralph`):
 *
 * - `@bot review [quick|standard|deep]`: a full review of the current head
 *   (duplicates of the PR's open findings are still dropped), optionally at
 *   another review depth than the repository's.
 * - `@bot review fresh [quick|standard|deep]`: the same from scratch: nothing
 *   is dropped as a duplicate, and matching earlier findings are superseded.
 * - `@bot dismiss [reason]` in a finding's thread: dismisses the finding. The
 *   reason may start with `false positive` (the default), `won't fix`,
 *   `not relevant` or `other`; the rest is kept as the note.
 * - `@bot fix [text]` on a PR/MR ralph opened: ralph makes the change (in a
 *   finding's thread, fixes that finding, with the rest of its review as
 *   context) and pushes it.
 * - `@bot help` (or a bare mention): lists the commands.
 * - Anything else is a question; in a finding's thread the agent answers it.
 *   Outside finding threads on a ralph PR/MR it is a request for ralph, and
 *   so it is in a finding's thread when the ralph run has a tracker
 *   session (with the finding and its review as context).
 *
 * Commands are case-insensitive. Mentions inside code (fenced blocks or
 * inline code), quoted lines (`>`) and HTML comments don't count, so quoting
 * the bot or documenting the commands doesn't trigger them.
 */
import { isReviewDepth, MAX_REPLY_QUESTION_LENGTH, type ReviewDepth } from "@omniralph/shared";

export const DEFAULT_BOT_HANDLE = "omniralph";
/** Longest dismissal note kept from `@bot dismiss`. */
export const MAX_DISMISS_NOTE_LENGTH = 1000;
/** Longest request kept from `@bot fix [text]`. */
export const MAX_FIX_TEXT_LENGTH = 4000;

export type DismissReason = "false_positive" | "wont_fix" | "not_relevant" | "other";

export type BotCommand =
  | { kind: "review"; fresh: boolean; depth: ReviewDepth | null }
  | { kind: "dismiss"; reason: DismissReason; note: string | null }
  | { kind: "fix"; text: string | null }
  | { kind: "help" }
  | { kind: "question"; text: string };

/** The bot's handle from `BOT_HANDLE` (a leading `@` is dropped), or `omniralph`. */
export function botHandle(env: Record<string, string | undefined> = process.env): string {
  const handle = env.BOT_HANDLE?.trim().replace(/^@/, "");
  return handle || DEFAULT_BOT_HANDLE;
}

/**
 * The bot's handle on a connection: a GitLab connection's bot username (its
 * token user), otherwise (GitHub, or GitLab connections from before the
 * username was stored) `fallback`, default `botHandle()`.
 */
export function connectionBotHandle(
  connection: { provider: string; botUsername: string | null },
  fallback: string = botHandle(),
): string {
  return (connection.provider === "gitlab" && connection.botUsername?.trim()) || fallback;
}

/**
 * Whether a comment was written by the bot itself (or another bot account):
 * those are never parsed for commands. GitHub App comments come from
 * `<slug>[bot]` accounts of type `Bot`; on GitLab the bot is the user whose
 * username is the handle.
 */
export function isOwnComment(
  author: { username: string; isBot: boolean },
  handle: string,
): boolean {
  if (author.isBot) return true;
  const name = author.username.toLowerCase().replace(/\[bot\]$/, "");
  return name === handle.toLowerCase();
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The comment's prose: without fenced code, inline code, quoted lines and HTML comments. */
function prose(text: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      lines.push("");
      continue;
    }
    if (marker) {
      fence = marker;
      lines.push("");
      continue;
    }
    lines.push(/^ {0,3}>/.test(line) ? "" : line);
  }
  return lines
    .join("\n")
    .replace(/<!--[\s\S]*?(-->|$)/g, " ")
    .replace(/(`+)[\s\S]*?\1/g, " ");
}

/**
 * The text before and after the first mention of `handle` (in the comment's
 * prose), or null when it isn't mentioned.
 */
function splitAtMention(text: string, handle: string): { before: string; after: string } | null {
  const mention = new RegExp(`(^|[^\\w@./-])@${escapeRegExp(handle)}(?:\\[bot\\])?(?![\\w-])`, "i");
  const visible = prose(text);
  const match = mention.exec(visible);
  if (!match) return null;
  return {
    before: visible.slice(0, match.index),
    after: visible.slice(match.index + match[0].length),
  };
}

const DISMISS_REASONS: { pattern: RegExp; reason: DismissReason }[] = [
  { pattern: /^(false[\s_-]*positive|fp)\b/i, reason: "false_positive" },
  { pattern: /^(won'?t[\s_-]*fix|wont_fix)(?![\w])/i, reason: "wont_fix" },
  { pattern: /^not[\s_-]*relevant\b/i, reason: "not_relevant" },
  { pattern: /^other\b/i, reason: "other" },
];

function dismissCommand(args: string): BotCommand {
  let rest = args.trim();
  let reason: DismissReason = "false_positive";
  for (const candidate of DISMISS_REASONS) {
    const match = candidate.pattern.exec(rest);
    if (match) {
      reason = candidate.reason;
      rest = rest.slice(match[0].length).replace(/^[\s:,.;—–-]+/, "");
      break;
    }
  }
  const note = rest.trim().slice(0, MAX_DISMISS_NOTE_LENGTH).trim();
  return { kind: "dismiss", reason, note: note || null };
}

/**
 * `@bot fix [text]`: the text after `fix`, taken from the comment as written
 * (code included) when the command is found there, else from its prose.
 */
function fixCommand(text: string, handle: string, proseRest: string): BotCommand {
  const raw = new RegExp(
    `(^|[^\\w@./-])@${escapeRegExp(handle)}(?:\\[bot\\])?\\s+fix(?![\\w-])[.,:;!?]*`,
    "i",
  ).exec(text.replace(/\r\n?/g, "\n"));
  const after = raw ? text.replace(/\r\n?/g, "\n").slice(raw.index + raw[0].length) : proseRest;
  const request = after.trim().slice(0, MAX_FIX_TEXT_LENGTH).trim();
  return { kind: "fix", text: request || null };
}

/** Splits off the first word, ignoring trailing punctuation (`review.`, `deep!`). */
function firstWord(text: string): { word: string; rest: string } {
  const match = /^(\S+)([\s\S]*)$/.exec(text.trimStart());
  if (!match) return { word: "", rest: "" };
  return { word: match[1]!.toLowerCase().replace(/[.,:;!?]+$/, ""), rest: match[2]! };
}

/**
 * The command of a comment that mentions the bot, or null when it doesn't.
 * See the module comment for the grammar.
 */
export function parseBotCommand(text: string, handle: string): BotCommand | null {
  const parts = splitAtMention(text, handle);
  if (parts === null) return null;
  const { word, rest } = firstWord(parts.after);
  const line = rest.split("\n")[0]!.trim();

  const bare = word === "" && !/[\p{L}\p{N}]/u.test(parts.before + parts.after);
  if (bare || word === "help") return { kind: "help" };
  if (word === "review") {
    const args = line
      .split(/\s+/)
      .filter(Boolean)
      .map((arg) => arg.toLowerCase().replace(/[.,:;!?]+$/, ""));
    const fresh = args[0] === "fresh";
    if (fresh) args.shift();
    const depth = args[0];
    if (args.length === 0) return { kind: "review", fresh, depth: null };
    if (args.length === 1 && isReviewDepth(depth)) return { kind: "review", fresh, depth };
  } else if (word === "dismiss") {
    return dismissCommand(rest);
  } else if (word === "fix") {
    return fixCommand(text, handle, rest);
  }
  const question = text.trim().slice(0, MAX_REPLY_QUESTION_LENGTH);
  return { kind: "question", text: question };
}
