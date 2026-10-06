/**
 * Sanitizes model output before the bot posts it. Finding text is derived
 * from untrusted PR content (prompt injection), so in prose:
 * - raw HTML and HTML comments are stripped and images dropped;
 * - links to any host but the repo's own code host become inline code (not clickable);
 * - `@mentions` other than the PR author's (and `allowedMentions`) are neutralized (inline code);
 * - lengths are capped.
 * Code (fenced blocks and inline code spans) is kept verbatim: code hosts render it
 * as text. Unterminated fences are closed. Suggestions are only ever posted as fenced
 * code (the SCM adapters fence them past any backtick run in the content).
 */

export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 4_000;
export const MAX_SUMMARY_CHARS = 20_000;

export interface SanitizeContext {
  /** Hosts whose links stay clickable: the repo's code host, e.g. `github.com`. */
  allowedHosts: readonly string[];
  /** The PR/MR author's username, a mention left intact. */
  author?: string | null;
  /** Further usernames whose mentions are left intact (case-insensitive). */
  allowedMentions?: readonly string[];
}

const TRUNCATED = "\n\n_…truncated_";
/** Placeholder delimiter; stripped from the input so it can't forge placeholders. */
const MARK = "\u0000";

/** Inline code that survives backticks in the content. */
export function inlineCode(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${marks}${pad}${flat}${pad}${marks}`;
}

interface Segment {
  code: boolean;
  text: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Splits markdown into prose and fenced code blocks; an unterminated fence is closed. */
function splitFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split("\n");
  let prose: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]!);
    // A backtick fence's info string can't contain backticks.
    if (!open || (open[1]![0] === "`" && lines[i]!.slice(open[0].length).includes("`"))) {
      prose.push(lines[i]!);
      i += 1;
      continue;
    }
    if (prose.length > 0) segments.push({ code: false, text: prose.join("\n") });
    prose = [];
    const fence = open[1]!;
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const block = [lines[i]!];
    i += 1;
    let closed = false;
    while (i < lines.length) {
      block.push(lines[i]!);
      i += 1;
      if (close.test(block[block.length - 1]!)) {
        closed = true;
        break;
      }
    }
    if (!closed) block.push(fence);
    segments.push({ code: true, text: block.join("\n") });
  }
  if (prose.length > 0) segments.push({ code: false, text: prose.join("\n") });
  return segments;
}

/** Replaces inline code spans with placeholders (their content stays verbatim). */
function protectCodeSpans(text: string, store: (code: string) => string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    if (tick < 0) break;
    let run = tick;
    while (text[run] === "`") run += 1;
    const marks = text.slice(tick, run);
    // The span ends at the next backtick run of exactly the same length.
    const closing = new RegExp(`(?<!\`)${marks}(?!\`)`, "g");
    closing.lastIndex = run;
    const end = closing.exec(text);
    if (!end) {
      out += text.slice(i, run);
      i = run;
      continue;
    }
    out += text.slice(i, tick) + store(text.slice(tick, end.index + marks.length));
    i = end.index + marks.length;
  }
  return out + text.slice(i);
}

function hostAllowed(host: string, ctx: SanitizeContext): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return ctx.allowedHosts.some((allowed) => allowed.toLowerCase() === normalized);
}

/**
 * Whether a link target may stay clickable: http(s) URLs on an allowed host,
 * and relative links (they resolve on the code host). Anything else
 * (other hosts, protocol-relative URLs, `javascript:`, `data:` ...) may not.
 */
export function linkAllowed(target: string, ctx: SanitizeContext): boolean {
  const url = target.trim();
  if (url.startsWith("//") || url.startsWith("\\")) return false;
  if (/^www\./i.test(url)) return false;
  // Browsers ignore tabs/newlines and leading control characters in schemes.
  /* eslint-disable no-control-regex -- control characters are what these patterns look for */
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url.replace(/[\u0000- ]/g, ""));
  if (!scheme) return !/[\u0000-\u001f\\]/.test(url);
  /* eslint-enable no-control-regex */
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      hostAllowed(parsed.hostname, ctx)
    );
  } catch {
    return false;
  }
}

/**
 * `@user`, `@org/team`, `@group/subgroup`, with the preceding character in
 * group 1 and the name in group 2. Emails and code spans don't match.
 */
const MENTION =
  /(^|[^A-Za-z0-9_`/.@+-])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?(?:\/[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)*)/g;

/** The distinct names (`user`, `org/team`) mentioned in `text`, lowercased. */
export function mentionedNames(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[2]!.toLowerCase()))];
}

function sanitizeProse(text: string, ctx: SanitizeContext, store: (code: string) => string) {
  const allowed = new Set(
    [ctx.author, ...(ctx.allowedMentions ?? [])]
      .filter((n): n is string => !!n)
      .map((n) => n.toLowerCase()),
  );
  let out = protectCodeSpans(text, store);

  // HTML comments (also unterminated ones, which hide the rest of the text).
  out = out.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  // Images: inline, reference-style and HTML (`<img>` goes with the tags below).
  out = out.replace(/!\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+[^)]*)?\)/g, "");
  out = out.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "");
  // Inline links: keep the text, show a foreign target as code.
  out = out.replace(
    /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?)\s*\)/g,
    (_match, label: string, rawTarget: string) => {
      const target = rawTarget.replace(/^<|>$/g, "");
      if (linkAllowed(target, ctx)) return `[${label}](${store(`<${target}>`)})`;
      return label.trim() ? `${label} (${store(inlineCode(target))})` : store(inlineCode(target));
    },
  );
  // Reference definitions: `[ref]: url "title"`.
  out = out.replace(
    /^ {0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?.*$/gm,
    (line, _label: string, target: string) =>
      linkAllowed(target, ctx) ? store(line) : store(inlineCode(target)),
  );
  // Autolinks `<scheme:...>`.
  out = out.replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/g, (_match, target: string) =>
    linkAllowed(target, ctx) ? store(`<${target}>`) : store(inlineCode(target)),
  );
  // Raw HTML tags (including `<img>`), then anything that could still open one.
  out = out.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, "");
  out = out.replace(/<(?=[A-Za-z/!?])/g, "&lt;");
  // Bare URLs, which code hosts autolink (they stop at a placeholder's delimiter).
  // eslint-disable-next-line no-control-regex
  out = out.replace(/\b(?:https?:\/\/|www\.)[^\s<>\u0000]+/gi, (match: string) => {
    const url = match.replace(/[.,:;!?'")\]*_~]+$/, "");
    const rest = match.slice(url.length);
    return (linkAllowed(url, ctx) ? store(url) : store(inlineCode(url))) + rest;
  });
  // Mentions (`@user`, `@org/team`, `@group/subgroup`); emails are left alone.
  out = out.replace(MENTION, (match, before: string, name: string) =>
    allowed.has(name.toLowerCase()) ? match : `${before}${store(inlineCode(`@${name}`))}`,
  );
  return out;
}

/** Sanitizes model-written markdown (no length cap). */
export function sanitizeMarkdown(text: string, ctx: SanitizeContext): string {
  const stored: string[] = [];
  const store = (code: string) => `${MARK}${stored.push(code) - 1}${MARK}`;
  const input = text.replaceAll(MARK, "").replace(/\r\n?/g, "\n");
  const out = splitFences(input)
    .map((segment) => (segment.code ? segment.text : sanitizeProse(segment.text, ctx, store)))
    .join("\n");
  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_m, i: string) => stored[+i]!);
}

/**
 * Sanitizes and caps at `max` characters. Truncation happens on the input and
 * is sanitized again, so cutting can't reopen code spans or fences.
 */
export function sanitizeCapped(text: string, ctx: SanitizeContext, max: number): string {
  let out = sanitizeMarkdown(text, ctx);
  let keep = text.length;
  while (out.length > max) {
    keep = Math.max(0, Math.min(keep - 1, keep - (out.length - max) - TRUNCATED.length));
    out = sanitizeMarkdown(`${text.slice(0, keep)}${TRUNCATED}`, ctx);
    if (keep === 0) return out.slice(0, max);
  }
  return out;
}

/** A one-line title. */
export function sanitizeTitle(text: string, ctx: SanitizeContext): string {
  const line = text.replace(/\s+/g, " ").trim();
  let out = sanitizeMarkdown(line, ctx).replace(/\s+/g, " ").trim();
  let keep = line.length;
  while (out.length > MAX_TITLE_CHARS) {
    keep = Math.max(0, Math.min(keep - 1, keep - (out.length - MAX_TITLE_CHARS) - 1));
    out = `${sanitizeMarkdown(line.slice(0, keep), ctx).trim()}…`;
    if (keep === 0) return out.slice(0, MAX_TITLE_CHARS);
  }
  return out;
}

export interface FindingText {
  title: string;
  body: string;
  suggestion?: string | null;
}

/** A finding's text, ready to post. The suggestion stays verbatim (it's posted as fenced code). */
export function sanitizeFinding(
  finding: FindingText,
  ctx: SanitizeContext,
): { title: string; body: string; suggestion?: string } {
  return {
    title: sanitizeTitle(finding.title, ctx),
    body: sanitizeCapped(finding.body, ctx, MAX_BODY_CHARS),
    ...(finding.suggestion != null ? { suggestion: finding.suggestion } : {}),
  };
}

/** Caps a (trusted, already rendered) summary comment. */
export function capSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  return summary.slice(0, MAX_SUMMARY_CHARS - TRUNCATED.length) + TRUNCATED;
}
