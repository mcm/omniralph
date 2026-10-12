import { Badge, Muted } from "@iamthemcmaster/ui";
import type { ReactNode } from "react";

/** The path of an agent's detail page (built-in IDs contain a colon). */
export function agentHref(id: string): string {
  return `/settings/agents/${encodeURIComponent(id)}`;
}

/** The path of a custom agent's edit page. */
export function agentEditHref(id: string): string {
  return `${agentHref(id)}/edit`;
}

export function TaskTypeBadges({ taskTypes }: { taskTypes: readonly string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
      {taskTypes.map((taskType) => (
        <Badge key={taskType} variant="neutral">
          {taskType}
        </Badge>
      ))}
    </div>
  );
}

export function BuiltinBadge() {
  return <Badge variant="neutral">Built-in</Badge>;
}

/** An agent's model, or what a null model falls back to. */
export function ModelName({ model }: { model: string | null }) {
  if (model === null) return <Muted>Profile default</Muted>;
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>{model}</span>
  );
}

export const pageMain = {
  flex: 1,
  overflowY: "auto",
  padding: "var(--space-8)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-6)",
} as const;

export const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;

export const stack = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
const factLabel = { fontSize: "var(--text-xs)", color: "var(--text-tertiary)" } as const;
export const preBlock = {
  ...mono,
  margin: 0,
  padding: "var(--space-3)",
  background: "var(--bg-raised)",
  borderRadius: "var(--radius-sm)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 480,
  overflowY: "auto",
} as const;

/** A labelled value of a detail page. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <span style={factLabel}>{label}</span>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>{children}</div>
    </div>
  );
}

export function NameList({ names }: { names: readonly string[] }) {
  if (names.length === 0) return <Muted>None</Muted>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
      {names.map((name) => (
        <Badge key={name} variant="neutral">
          {name}
        </Badge>
      ))}
    </div>
  );
}
