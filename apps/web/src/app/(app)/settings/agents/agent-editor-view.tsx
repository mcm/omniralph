"use client";

import { notFound } from "next/navigation";
import { DefinitionLoading, notFoundOn404, useDefinitionId, useIsAdmin } from "../definition-page";
import { useAgentDetail, useAgentFormOptions } from "../definition-queries";
import { AgentForm } from "./agent-form";
import { agentHref } from "./agent-parts";

/** Creates one of the organization's agents. Admins only. */
export function NewAgentView() {
  const isAdmin = useIsAdmin({ required: true });
  const choices = useAgentFormOptions({ enabled: isAdmin });
  if (choices.data) return <AgentForm agent={null} choices={choices.data} />;
  return (
    <DefinitionLoading
      breadcrumbs={[{ label: "Agents", href: "/settings/agents" }, { label: "New" }]}
      query={choices}
      what="the agent form"
    />
  );
}

/**
 * Edits one of the organization's agents, seeded from the live agent: a change saved
 * elsewhere shows while the form isn't edited, never over an edit. Admins only; built-ins
 * (read-only) and unknown IDs, another organization's too, are not found.
 */
export function EditAgentView() {
  const id = useDefinitionId();
  const isAdmin = useIsAdmin({ required: true });
  const detail = useAgentDetail(id, { enabled: isAdmin });
  const choices = useAgentFormOptions({ enabled: isAdmin });
  if (detail.data?.builtin) notFound();
  if (detail.data && choices.data) {
    return <AgentForm agent={detail.data.agent} choices={choices.data} />;
  }
  if (!detail.data) notFoundOn404(detail.error);
  return (
    <DefinitionLoading
      breadcrumbs={[
        { label: "Agents", href: "/settings/agents" },
        { label: detail.data?.agent.name ?? "Agent", href: agentHref(id) },
        { label: "Edit" },
      ]}
      query={detail.data ? choices : detail}
      what="the agent"
    />
  );
}
