"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import {
  agentDetailSchema,
  agentLastSeenSchema,
  agentListSchema,
  enrollmentStatusSchema,
  type AgentDetail,
  type AgentLastSeen,
  type AgentList,
  type CreatedEnrollment,
  type EnrollmentStatus,
} from "@/lib/api/agents";
import type { QueryKeys } from "@/lib/api/keys";
import { useScopeParam } from "../scope";

/**
 * Query keys of Fleet: the agents of a scope under `keys.agents.lists`, and an enrollment's
 * status under it too, so the `agent` change event of an enrolling agent (whose ID nobody
 * knows yet) refetches it. `agents` is a scope-wide area: under "All organizations" every
 * organization's agent events reach them.
 */
export function fleetKeys(keys: QueryKeys) {
  return {
    lists: keys.agents.lists,
    list: (scope: string): QueryKey => keys.agents.list({ organization: scope }),
    detail: (agentId: string): QueryKey => keys.agents.detail(agentId),
    lastSeen: (agentId: string): QueryKey => keys.agents.part(agentId, "last-seen"),
    enrollment: (enrollmentId: string): QueryKey => [
      ...keys.agents.lists,
      "enrollment",
      enrollmentId,
    ],
  };
}

/**
 * Fleet's agents and summary for the user's scope (`GET /api/ui/agents?organization=`). A
 * live query: `agent` change events (an agent saved, coming online, marked offline by the
 * liveness cron, starting or finishing work) refetch it.
 */
export function useFleet() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<AgentList>({
    queryKey: fleetKeys(keys).list(scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/agents", agentListSchema, {
        params: { organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * One agent's detail (`GET /api/ui/agents/{id}`), of any of the user's organizations. A live
 * query: the agent's `agent` change events (a heartbeat that changes what the panel shows,
 * going offline, starting or finishing an attempt) refetch it.
 */
export function useAgentDetail(agentId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<AgentDetail>({
    queryKey: fleetKeys(keys).detail(agentId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/agents/${encodeURIComponent(agentId)}`, agentDetailSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** How often the open agent panel polls the agent's last heartbeat (and its badge ticks). */
export const LAST_SEEN_POLL_MS = 10_000;

/**
 * The agent's last heartbeat from Redis (`GET /api/ui/agents/{id}/last-seen`), polled every
 * 10 s while the panel is mounted and the document is visible (no polling in the
 * background): steady heartbeats publish no change event to refetch on.
 */
export function useAgentLastSeen(agentId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<AgentLastSeen>({
    queryKey: fleetKeys(keys).lastSeen(agentId),
    refetchInterval: LAST_SEEN_POLL_MS,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) =>
      api.get(`/api/ui/agents/${encodeURIComponent(agentId)}/last-seen`, agentLastSeenSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * The agent that redeemed `enrollment`'s token, once one has
 * (`GET /api/ui/agent-enrollments/{id}`). A live query: enrolling publishes the new agent's
 * `agent` event, which refetches it; it never polls on its own.
 */
export function useEnrollmentStatus(enrollment: CreatedEnrollment | null) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<EnrollmentStatus>({
    queryKey: fleetKeys(keys).enrollment(enrollment?.id ?? "none"),
    enabled: enrollment !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/ui/agent-enrollments/${encodeURIComponent(enrollment!.id)}`,
        enrollmentStatusSchema,
        { organizationId: organization.id, signal },
      ),
  });
}
