/** A part of a run's "Routed by": plain text, or a team, project or label it names. */
export type RoutedByPart =
  { kind: "text"; text: string } | { kind: "team" | "project" | "label"; name: string };

const NAMED = /\b(team|project|label) `([^`]+)`/gi;
const MATCH_ROUTE = /^work item match \((.*)\)$/;
const MATCH_PART = /^(?:(Team) is|(project)|(label)) (.+)$/;

const lower = (kind: string) => kind.toLowerCase() as "team" | "project" | "label";

/** Pushes `text`, joining it to a text part before it. */
function pushText(parts: RoutedByPart[], text: string): void {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.kind === "text") last.text += text;
  else parts.push({ kind: "text", text });
}

/**
 * How a run's repo was chosen (`routed_by`), split into the teams, projects and labels it
 * names (shown as badges) and the text between: "team `SOC` and label `product:portal`", or
 * a work item match "work item match (Team is SOC, project Portal, label billing)".
 */
export function routedByParts(routedBy: string): RoutedByPart[] {
  const parts: RoutedByPart[] = [];
  const match = MATCH_ROUTE.exec(routedBy);
  if (match) {
    pushText(parts, "work item match: ");
    match[1]!.split(", ").forEach((piece, index) => {
      if (index > 0) pushText(parts, ", ");
      const named = MATCH_PART.exec(piece);
      const kind = named?.[1] ?? named?.[2] ?? named?.[3];
      if (named && kind) parts.push({ kind: lower(kind), name: named[4]! });
      else pushText(parts, piece);
    });
    return parts;
  }
  let last = 0;
  for (const named of routedBy.matchAll(NAMED)) {
    pushText(parts, routedBy.slice(last, named.index));
    parts.push({ kind: lower(named[1]!), name: named[2]! });
    last = named.index + named[0].length;
  }
  pushText(parts, routedBy.slice(last));
  return parts;
}

/** A token count in compact form: "950", "8.4k", "225k", "45.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A run's tokens: "45.2M in · 225k out". */
export function tokensText(tokens: { in: number; out: number }): string {
  return `${formatTokens(tokens.in)} in · ${formatTokens(tokens.out)} out`;
}
