"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import {
  agentListSchema,
  enrollmentStatusSchema,
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
