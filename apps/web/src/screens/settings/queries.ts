"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { connectionListSchema, type ConnectionList } from "@/lib/api/connections";
import { deliveryListSchema, type DeliveryRow } from "@/lib/api/deliveries";
import { chatPlaybooksSettingsSchema, type ChatPlaybooksSettings } from "@/lib/api/integrations";
import {
  chatPlaybooksKey,
  connectionKeys,
  deliveryKeys,
  organizationKeys,
  type QueryKeys,
} from "@/lib/api/keys";
import {
  chatAccountsSchema,
  organizationSettingsSchema,
  type ChatAccounts,
  type OrganizationSettings,
} from "@/lib/api/organization";
import { routingRulesSchema, type RoutingRules } from "@/lib/api/routing-rules";
import { trackerStateMappingSchema, type TrackerStateMappingView } from "@/lib/api/trackers";
import { DELIVERY_FILTERS, type DeliveryFilter } from "./replay";

/**
 * The active organization's connections (`GET /api/ui/connections`), for Settings' nav and
 * connection pages. A live query: `connection` change events (a connection added, renamed
 * or removed) refetch it.
 */
export function useConnections() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<ConnectionList>({
    queryKey: connectionKeys(keys).list,
    queryFn: ({ signal }) =>
      api.get("/api/ui/connections", connectionListSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * A code-host or Linear connection's webhook deliveries, newest first, of one outcome filter
 * (`GET /api/ui/connections/{scm|linear}/{id}/deliveries`), a page at a time ("Show more"
 * fetches the next with `nextCursor`). A live query: a `webhook_event` change event naming
 * the connection (a delivery recorded or replayed) refetches every loaded page.
 */
export function useDeliveries(
  connection: { kind: DeliveryRow["connection"]["kind"]; id: string },
  filter: DeliveryFilter,
) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  const { kind } = connection;
  return useInfiniteQuery({
    queryKey: deliveryKeys(keys).list(connection.id, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get(
        `/api/ui/connections/${kind}/${encodeURIComponent(connection.id)}/deliveries`,
        deliveryListSchema,
        {
          params: { outcome: [...DELIVERY_FILTERS[filter]], cursor: pageParam },
          organizationId: organization.id,
          signal,
        },
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * The active organization's settings (`GET /api/ui/organization`): its name and its latest
 * change for Organization › General, its members, invitations and domains. A live query:
 * an `organization` event of the organization (a rename, a member, an invitation or a domain
 * by any admin) refetches it, and the shell's organization name follows it.
 */
export function useOrganizationSettings() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<OrganizationSettings>({
    queryKey: organizationKeys(keys).settings,
    queryFn: ({ signal }) =>
      api.get("/api/ui/organization", organizationSettingsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The signed-in user's linked chat accounts' query key (keyed by the active organization). */
export function chatAccountsKey(keys: QueryKeys) {
  return keys.chatAccounts.list();
}

/**
 * The signed-in user's linked Slack and Discord accounts in every organization
 * (`GET /api/ui/chat-accounts`), for You › Linked chat accounts. A live query: a link or
 * unlink in any of the user's organizations (`settings` section `linked_accounts` on the
 * user's own channel) refetches it.
 */
export function useChatAccounts() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<ChatAccounts>({
    queryKey: chatAccountsKey(keys),
    queryFn: ({ signal }) =>
      api.get("/api/ui/chat-accounts", chatAccountsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The organization's routing rules' query key. */
export function routingRulesKey(keys: QueryKeys) {
  return keys.settings.detail("routing");
}

/**
 * The organization's routing rules and what editing them needs (`GET /api/ui/routing-rules`),
 * for Advanced › Routing rules. A live query: a save by any admin (`settings` section
 * `routing_rules`) refetches it.
 */
export function useRoutingRules() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<RoutingRules>({
    queryKey: routingRulesKey(keys),
    queryFn: ({ signal }) =>
      api.get("/api/ui/routing-rules", routingRulesSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * A tracker connection's work item state mapping and the workspace's workflow states
 * (`GET /api/ui/trackers/{id}/state-mapping`), for the Linear connection page's "Work item
 * states" card. A live query: the connection's `connection` events (another admin's save, a
 * disconnect) refetch it.
 */
export function useTrackerStateMapping(integrationId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<TrackerStateMappingView>({
    queryKey: connectionKeys(keys).stateMapping(integrationId),
    queryFn: ({ signal }) =>
      api.get(
        `/api/ui/trackers/${encodeURIComponent(integrationId)}/state-mapping`,
        trackerStateMappingSchema,
        { organizationId: organization.id, signal },
      ),
  });
}

/**
 * The playbooks chat runs (`GET /api/ui/integrations/chat-tasks`, any member), for Advanced ›
 * Chat channel overrides. A live query: a `chat_playbooks` settings event (another admin's
 * save), a playbook save and a `connection` event refetch it.
 */
export function useChatPlaybooks() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<ChatPlaybooksSettings>({
    queryKey: chatPlaybooksKey(keys),
    queryFn: ({ signal }) =>
      api.get("/api/ui/integrations/chat-tasks", chatPlaybooksSettingsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}
