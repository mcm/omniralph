"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { connectionListSchema, type ConnectionList } from "@/lib/api/connections";
import { connectionKeys, organizationKeys, type QueryKeys } from "@/lib/api/keys";
import {
  chatAccountsSchema,
  organizationSettingsSchema,
  type ChatAccounts,
  type OrganizationSettings,
} from "@/lib/api/organization";

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
