import { Badge, Muted } from "@iamthemcmaster/ui";

/** The path of an agent's detail page (built-in IDs contain a colon). */
export function agentHref(id: string): string {
  return `/settings/agents/${encodeURIComponent(id)}`;
}

export function TaskTypeBadges({ taskTypes }: { taskTypes: readonly string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
      {taskTypes.map((taskType) => (
        <Badge key={taskType} variant="outline">
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
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
} as const;

export const pageTitle = {
  margin: 0,
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--font-weight-semibold)",
} as const;

export const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;
