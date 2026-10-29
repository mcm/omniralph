/**
 * The prompt template engine: a logic-less subset of Mustache. Templates may
 * use variables (`{{name}}`, dotted names, `{{.}}` for the current section
 * item), sections (`{{#name}}…{{/name}}`), inverted sections
 * (`{{^name}}…{{/name}}`) and comments (`{{! … }}`). Partials, triple
 * mustache, `{{& x}}`, delimiter changes and lambdas don't exist; a `{{`
 * right after a backslash is literal text instead (`\{{` renders `{{`, as in
 * Handlebars). Nothing is HTML-escaped.
 *
 * Untrusted values are fenced by the renderer itself, using the variable
 * catalog, so a template can neither forget to fence user input nor opt out.
 * As in Mustache, section, inverted-section, closing and comment tags that
 * stand alone on their line remove that whole line.
 */
import { VARIABLES, type VariableDefinition } from "./variables.js";

export interface TemplatePosition {
  /** 1-based line of the tag's `{{`. */
  line: number;
  /** 1-based column of the tag's `{{`. */
  column: number;
}

export interface TemplateParseError extends TemplatePosition {
  message: string;
}

export type TemplateNode =
  | { type: "text"; text: string }
  | ({ type: "variable"; name: string } & TemplatePosition)
  | ({
      type: "section" | "inverted";
      name: string;
      children: TemplateNode[];
    } & TemplatePosition);

export type ParseResult =
  | { ok: true; nodes: TemplateNode[] }
  | { ok: false; error: TemplateParseError };

export type TemplateProblem =
  | ({ kind: "parse"; message: string } & TemplatePosition)
  | ({ kind: "unknown-variable"; name: string } & TemplatePosition);

export class TemplateError extends Error {
  constructor(readonly error: TemplateParseError) {
    super(`${error.message} (line ${error.line}, column ${error.column})`);
    this.name = "TemplateError";
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

interface Tag extends TemplatePosition {
  /** Offset of `{{`. */
  start: number;
  /** Offset just past `}}`. */
  end: number;
  sigil: "" | "#" | "^" | "/" | "!";
  name: string;
}

function positionAt(template: string, offset: number): TemplatePosition {
  const before = template.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}

function scanTag(template: string, start: number): Tag | TemplateParseError {
  const position = positionAt(template, start);
  const fail = (message: string): TemplateParseError => ({ message, ...position });
  const close = template.indexOf("}}", start + 2);
  if (close === -1) return fail("Unclosed tag: missing `}}`");
  const end = close + 2;
  let raw = template.slice(start + 2, close);

  const first = raw[0];
  if (first === "{") return fail("Triple mustache is not supported");
  if (first === "&") return fail("Unescaped variables (`{{& x}}`) are not supported");
  if (first === ">") return fail("Partials are not supported");
  if (first === "<") return fail("Parent templates are not supported");
  if (first === "$") return fail("Blocks are not supported");
  if (first === "=") return fail("Delimiter changes are not supported");
  if (first === "!") {
    return { start, end, sigil: "!", name: "", ...position };
  }

  let sigil: Tag["sigil"] = "";
  if (first === "#" || first === "^" || first === "/") {
    sigil = first;
    raw = raw.slice(1);
  }
  // `{{name}}}` would leave a stray brace in the output; reject it like `{{{`.
  if (template[end] === "}") return fail("Triple mustache is not supported");
  const name = raw.trim();
  if (name === "") return fail("Empty tag");
  if (!(name === "." || NAME.test(name))) return fail(`Invalid name \`${name}\``);
  if (name === "." && sigil !== "") return fail("`.` can't name a section");
  return { start, end, sigil, name, ...position };
}

/**
 * Bounds of the line around a tag if the tag stands alone on it (only
 * whitespace around it): the line's start and the offset after its newline.
 */
function standaloneBounds(template: string, tag: Tag): { from: number; to: number } | undefined {
  const lineStart = template.lastIndexOf("\n", tag.start - 1) + 1;
  if (!/^[ \t]*$/.test(template.slice(lineStart, tag.start))) return undefined;
  const newline = template.indexOf("\n", tag.end);
  const lineEnd = newline === -1 ? template.length : newline;
  if (!/^[ \t\r]*$/.test(template.slice(tag.end, lineEnd))) return undefined;
  return { from: lineStart, to: newline === -1 ? template.length : newline + 1 };
}

/** Parses a template, or reports the first construct it doesn't allow. */
export function parseTemplate(template: string): ParseResult {
  const root: TemplateNode[] = [];
  const stack: { node: Extract<TemplateNode, { type: "section" | "inverted" }> }[] = [];
  const current = () => stack.at(-1)?.node.children ?? root;
  const pushText = (text: string) => {
    if (text) current().push({ type: "text", text });
  };

  let offset = 0;
  for (;;) {
    const start = template.indexOf("{{", offset);
    if (start === -1) {
      pushText(template.slice(offset));
      break;
    }
    if (start > offset && template[start - 1] === "\\") {
      pushText(`${template.slice(offset, start - 1)}{{`);
      offset = start + 2;
      continue;
    }
    const tag = scanTag(template, start);
    if (!("sigil" in tag)) return { ok: false, error: tag };

    let textEnd = tag.start;
    let next = tag.end;
    if (tag.sigil !== "") {
      const bounds = standaloneBounds(template, tag);
      if (bounds && bounds.from >= offset) {
        textEnd = bounds.from;
        next = bounds.to;
      }
    }
    pushText(template.slice(offset, textEnd));
    offset = next;

    const position = { line: tag.line, column: tag.column };
    switch (tag.sigil) {
      case "!":
        break;
      case "":
        current().push({ type: "variable", name: tag.name, ...position });
        break;
      case "#":
      case "^": {
        const node = {
          type: tag.sigil === "#" ? ("section" as const) : ("inverted" as const),
          name: tag.name,
          children: [],
          ...position,
        };
        current().push(node);
        stack.push({ node });
        break;
      }
      case "/": {
        const open = stack.pop();
        if (!open) {
          return {
            ok: false,
            error: { message: `Closing tag \`${tag.name}\` has no open section`, ...position },
          };
        }
        if (open.node.name !== tag.name) {
          return {
            ok: false,
            error: {
              message: `Closing tag \`${tag.name}\` doesn't match section \`${open.node.name}\` (line ${open.node.line}, column ${open.node.column})`,
              ...position,
            },
          };
        }
        break;
      }
    }
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    const { name, line, column } = unclosed.node;
    return { ok: false, error: { message: `Section \`${name}\` is never closed`, line, column } };
  }
  return { ok: true, nodes: root };
}

/**
 * Walks parsed nodes resolving each variable and section name against
 * `availableVariables`: `found` gets each resolved catalog name, `missing`
 * each name that resolves to nothing. Inside a section, a name may also
 * resolve against the section item (`{{#finding}}{{title}}{{/finding}}` uses
 * `finding.title`). A section name is available if it is a variable or the
 * prefix of one.
 */
function resolveNames(
  nodes: readonly TemplateNode[],
  availableVariables: readonly string[],
  found: (name: string) => void,
  missing: (node: Exclude<TemplateNode, { type: "text" }>) => void,
): void {
  const available = new Set(availableVariables);
  const isPrefix = (name: string) => availableVariables.some((v) => v.startsWith(`${name}.`));

  // `scopes` are the full names of the enclosing sections, innermost last.
  const visit = (nodes: readonly TemplateNode[], scopes: readonly string[]) => {
    for (const node of nodes) {
      if (node.type === "text") continue;
      if (node.name === ".") {
        if (scopes.length === 0) missing(node);
        continue;
      }
      const candidates = [...scopes.map((scope) => `${scope}.${node.name}`).reverse(), node.name];
      if (node.type === "variable") {
        const resolved = candidates.find((c) => available.has(c));
        if (resolved) found(resolved);
        else missing(node);
        continue;
      }
      const resolved = candidates.find((c) => available.has(c) || isPrefix(c));
      if (!resolved) missing(node);
      else if (available.has(resolved)) found(resolved);
      visit(node.children, resolved ? [...scopes, resolved] : scopes);
    }
  };
  visit(nodes, []);
}

/**
 * Every problem with a template: its parse error, or each variable that isn't
 * available. Inside a section, a name may also resolve against the section
 * item (`{{#finding}}{{title}}{{/finding}}` uses `finding.title`). A section
 * name is available if it is a variable or the prefix of one. Empty when the
 * template is valid.
 */
export function validateTemplate(
  template: string,
  availableVariables: readonly string[],
): TemplateProblem[] {
  const parsed = parseTemplate(template);
  if (!parsed.ok) return [{ kind: "parse", ...parsed.error }];
  const problems: TemplateProblem[] = [];
  resolveNames(
    parsed.nodes,
    availableVariables,
    () => {},
    ({ name, line, column }) => problems.push({ kind: "unknown-variable", name, line, column }),
  );
  return problems;
}

/**
 * The names in `availableVariables` a template uses (as a variable or a
 * section name, resolved against enclosing sections), in order of first use; names that
 * resolve to nothing are left out. Empty when the template doesn't parse.
 */
export function templateVariables(
  template: string,
  availableVariables: readonly string[],
): string[] {
  const parsed = parseTemplate(template);
  if (!parsed.ok) return [];
  const used = new Set<string>();
  resolveNames(
    parsed.nodes,
    availableVariables,
    (name) => used.add(name),
    () => {},
  );
  return [...used];
}

/**
 * A fenced block longer than any backtick run inside `content`, so the content
 * can't close it. A copy of `fence()` in `@omniralph/engine`'s prompt.ts (a
 * test in the engine checks both agree), so ported prompts render byte for byte.
 */
export function fence(content: string, info = ""): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${info}\n${content.replace(/\n$/, "")}\n${marks}`;
}

/**
 * `text` (trimmed, `(empty)` when blank) between `<tag>` and `</tag>` lines,
 * with any `</tag>` inside defused so it can't close the quote. A copy of
 * `quote()` in `@omniralph/ralph`'s triage prompt, so it renders byte for byte.
 */
export function quote(tag: string, text: string): string {
  const body = text.trim() || "(empty)";
  return [`<${tag}>`, body.replaceAll(`</${tag}>`, `<\\/${tag}>`), `</${tag}>`].join("\n");
}

export type TemplateContext = Readonly<Record<string, unknown>>;

interface Scope {
  value: unknown;
  /** Full dotted name of the value (empty for the root context). */
  path: string;
}

function lookupIn(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, name)) return record[name];
  const dot = name.indexOf(".");
  if (dot === -1) return undefined;
  const head = name.slice(0, dot);
  return Object.hasOwn(record, head) ? lookupIn(record[head], name.slice(dot + 1)) : undefined;
}

function hasHead(value: unknown, name: string): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, name) || Object.hasOwn(record, name.split(".")[0]!);
}

/** Resolves `name` against the innermost scope that has it, as Mustache does. */
function resolve(scopes: readonly Scope[], name: string): Scope {
  const top = scopes.at(-1)!;
  if (name === ".") return top;
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    if (hasHead(scope.value, name)) {
      return { value: lookupIn(scope.value, name), path: joinPath(scope.path, name) };
    }
  }
  return { value: undefined, path: joinPath(top.path, name) };
}

function joinPath(path: string, name: string): string {
  return path ? `${path}.${name}` : name;
}

function isFalsy(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Marker after a value cut to its task's variable limit (as today's prompt builders do). */
export const TRUNCATION_MARKER = "\n[… truncated]";

/** Most characters of each variable rendered, by catalog name; longer values are cut and marked. */
export type VariableLimits = Readonly<Record<string, number>>;

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Renders a template against `context` (nested objects; a key may also hold a
 * dotted name). Values are not HTML-escaped. A value whose catalog entry is
 * untrusted is fenced with the entry's info string (or, for an entry with a
 * `quote` tag, quoted between tag lines, even when empty); trusted values render as
 * is; a missing or empty value renders as an empty string. Values without a
 * catalog entry are treated as untrusted. A value longer than its entry in
 * `limits` (a task's `variableLimits`) is cut to that many characters and
 * followed by `TRUNCATION_MARKER`, before it's fenced. Throws `TemplateError`
 * if the template doesn't parse.
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
  catalog: readonly VariableDefinition[] = VARIABLES,
  limits: VariableLimits = {},
): string {
  const parsed = parseTemplate(template);
  if (!parsed.ok) throw new TemplateError(parsed.error);
  const entries = new Map(catalog.map((variable) => [variable.name, variable]));

  const render = (nodes: readonly TemplateNode[], scopes: readonly Scope[]): string => {
    let out = "";
    for (const node of nodes) {
      if (node.type === "text") {
        out += node.text;
        continue;
      }
      const { value, path } = resolve(scopes, node.name);
      if (node.type === "variable") {
        const entry = entries.get(path);
        const quoted = entry?.trust === "untrusted" ? entry.quote : undefined;
        let text = stringify(value);
        // A quoted value is always quoted, so an empty one still reads `(empty)`.
        if (text === "" && quoted === undefined) continue;
        const limit = limits[path];
        if (limit !== undefined && text.length > limit) {
          text = `${text.slice(0, limit)}${TRUNCATION_MARKER}`;
        }
        if (entry?.trust === "trusted") out += text;
        else if (quoted !== undefined) out += quote(quoted, text);
        else out += fence(text, entry?.fence ?? "");
        continue;
      }
      if (node.type === "inverted") {
        if (isFalsy(value)) out += render(node.children, scopes);
        continue;
      }
      if (isFalsy(value)) continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) out += render(node.children, [...scopes, { value: item, path }]);
    }
    return out;
  };
  return render(parsed.nodes, [{ value: context, path: "" }]);
}
