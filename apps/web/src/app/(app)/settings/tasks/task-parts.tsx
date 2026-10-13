import Link from "next/link";
import { Badge, Cluster } from "@iamthemcmaster/ui";
import type { TaskType } from "@omniralph/tasks";
import { agentHref } from "../agents/agent-parts";
import { MonoValue } from "@/components/mono-value";

/** The path of a task's detail page (built-in IDs contain a colon). */
export function taskHref(id: string): string {
  return `/settings/tasks/${encodeURIComponent(id)}`;
}

/** The path of a custom task's edit page. */
export function taskEditHref(id: string): string {
  return `${taskHref(id)}/edit`;
}

/** How the list groups task types, in order. */
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  query: "Query",
  review: "Review",
  coding: "Coding",
};

export function TriggerBadges({ triggers }: { triggers: readonly string[] }) {
  return (
    <Cluster gap={1}>
      {triggers.map((trigger) => (
        // An event name (e.g. pr.updated), shown as the exact value.
        <Badge key={trigger} variant="neutral" className="text-numeric">
          {trigger}
        </Badge>
      ))}
    </Cluster>
  );
}

/** A task's agent: its name linking to its page, or the bare ID when it doesn't resolve. */
export function AgentLink({
  id,
  name,
  className = "text-sm text-text-primary",
}: {
  id: string;
  name: string | null;
  /** E.g. `list-secondary` under a row's title on phone. */
  className?: string;
}) {
  if (name === null) return <MonoValue value={id} className="text-xs text-text-secondary" />;
  return (
    <Link href={agentHref(id)} className={className}>
      {name}
    </Link>
  );
}
