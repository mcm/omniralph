"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { agentDefaultsSchema, hostToolCatalogSchema } from "@/lib/api/agent-defaults";
import type { QueryKeys } from "@/lib/api/keys";

/** The keys of Settings › Agent defaults' tabs. */
export const agentDefaultsKeys = (keys: QueryKeys) => ({
  defaults: keys.settings.detail("agent-defaults"),
  hostTools: keys.settings.detail("host-tools"),
});

/** The organization's agent defaults, live (`GET /api/ui/agent-defaults`, admins). */
export function useAgentDefaults() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: agentDefaultsKeys(keys).defaults,
    queryFn: ({ signal }) =>
      api.get("/api/ui/agent-defaults", agentDefaultsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The organization's host tool catalog, live (`GET /api/ui/host-tools`, admins). */
export function useHostToolCatalog() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: agentDefaultsKeys(keys).hostTools,
    queryFn: ({ signal }) =>
      api.get("/api/ui/host-tools", hostToolCatalogSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * What a defaults change affects: this tab, every agent query (the list's and detail's
 * desired version and update state, and the concurrency they inherit) and every
 * repository query (the agents' task types and version a repository's Agents tab shows).
 */
export const agentDefaultsChanged = (keys: QueryKeys) => [
  agentDefaultsKeys(keys).defaults,
  keys.agents.all,
  keys.repositories.all,
];

/**
 * What a host tool catalog change affects: this tab, every agent's Host tools tab and the
 * task editor's host tool choices.
 */
export const hostToolsChanged = (keys: QueryKeys) => [
  agentDefaultsKeys(keys).hostTools,
  keys.agents.all,
  keys.settings.detail("tasks"),
];
