import { Badge, Cluster, Muted } from "@iamthemcmaster/ui";
import type { ReactNode } from "react";
import { MonoValue } from "@/components/mono-value";

/** The path of an agent's detail page (built-in IDs contain a colon). */
export function agentHref(id: string): string {
  return `/settings/agents/${encodeURIComponent(id)}`;
}

/** The path of a custom agent's edit page. */
export function agentEditHref(id: string): string {
  return `${agentHref(id)}/edit`;
}

export function BuiltinBadge() {
  return <Badge variant="neutral">Built-in</Badge>;
}

/** An agent's model, or what a null model falls back to. */
export function ModelName({ model }: { model: string | null }) {
  if (model === null) return <Muted className="list-nowrap">Profile default</Muted>;
  return <MonoValue value={model} className="text-sm" />;
}

/** A labelled value of a detail page. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <div className="fact-value">{children}</div>
    </div>
  );
}

export function NameList({ names }: { names: readonly string[] }) {
  if (names.length === 0) return <Muted>None</Muted>;
  return (
    <Cluster gap={1}>
      {names.map((name) => (
        <Badge key={name} variant="neutral">
          {name}
        </Badge>
      ))}
    </Cluster>
  );
}
