import Link from "next/link";
import { Badge } from "@iamthemcmaster/ui";
import type { TaskType } from "@omniralph/tasks";
import { agentHref, mono } from "../agents/agent-parts";

/** The path of a task's detail page (built-in IDs contain a colon). */
export function taskHref(id: string): string {
  return `/settings/tasks/${encodeURIComponent(id)}`;
}

/** How the list groups task types, in order. */
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  query: "Query",
  review: "Review",
  coding: "Coding",
};

export function TriggerBadges({ triggers }: { triggers: readonly string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
      {triggers.map((trigger) => (
        <Badge key={trigger} variant="outline">
          {trigger}
        </Badge>
      ))}
    </div>
  );
}

/** A task's agent: its name linking to its page, or the bare ID when it doesn't resolve. */
export function AgentLink({ id, name }: { id: string; name: string | null }) {
  if (name === null) return <span style={{ ...mono, color: "var(--text-secondary)" }}>{id}</span>;
  return (
    <Link href={agentHref(id)} style={{ color: "var(--text-primary)", fontSize: "var(--text-sm)" }}>
      {name}
    </Link>
  );
}
