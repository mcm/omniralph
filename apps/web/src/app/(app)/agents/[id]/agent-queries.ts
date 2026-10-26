"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { agentDetailSchema, agentHostToolsSchema, agentInstallablesSchema } from "@/lib/api/agents";
import type { QueryKeys } from "@/lib/api/keys";

/** The page asking, so an agent of another organization switches to it and comes back here. */
function currentPage(): string | undefined {
  return typeof window === "undefined"
    ? undefined
    : `${window.location.pathname}${window.location.search}`;
}

/** An agent and what all its tabs show, live (`GET /api/ui/agents/{id}`). */
export function useAgentDetail(agentId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.agents.detail(agentId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/agents/${agentId}`, agentDetailSchema, {
        params: { next: currentPage() },
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The Installables tab: reported installables and recent install jobs, live. */
export function useAgentInstallables(agentId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.agents.part(agentId, "installables"),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/agents/${agentId}/installables`, agentInstallablesSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The Host tools tab: the catalog's host tools with this agent's paths and reports, live. */
export function useAgentHostTools(agentId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.agents.part(agentId, "host-tools"),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/agents/${agentId}/host-tools`, agentHostToolsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * What a change to an agent can affect: every agent list and detail, and the
 * Repos screen (which shows pins and the agents serving them).
 */
export function agentChanged(keys: QueryKeys): QueryKey[] {
  return [keys.agents.all, keys.repositories.all];
}
