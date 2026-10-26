"use client";

import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { organizationKeys, queryKeys } from "@/lib/api/keys";
import type { OrganizationSettings } from "@/lib/api/organization";
import { CurrentUserProvider, useCurrentUser, type SessionUser } from "./current-user";

/** `user` with the active organization named `name`, in `organization` and `organizations`. */
export function withOrganizationName(user: SessionUser, name: string): SessionUser {
  if (user.organization.name === name) return user;
  return {
    ...user,
    organization: { ...user.organization, name },
    organizations: user.organizations.map((option) =>
      option.id === user.organization.id ? { ...option, name } : option,
    ),
  };
}

/** The active organization's name in the cached `GET /api/ui/organization`, if it's cached. */
function useCachedOrganizationName(organizationId: string): string | undefined {
  const client = useQueryClient();
  const key = React.useMemo(
    () => organizationKeys(queryKeys(organizationId)).settings,
    [organizationId],
  );
  const subscribe = React.useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(onChange),
    [client],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => client.getQueryData<OrganizationSettings>(key)?.organization.name,
    () => undefined,
  );
}

/**
 * The session user with the active organization's name kept live: the server renders the
 * shell with the name at page load, and a rename (this user's save, or another admin's
 * `organization` event refetching the organization's settings) shows in everything that
 * reads `useCurrentUser()` (the organization picker, Settings' badge) at once. The latest
 * cached name stays after its query leaves the cache, until the server renders the shell
 * again with a name of its own.
 */
export function LiveCurrentUser({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();
  const cached = useCachedOrganizationName(user.organization.id);
  const session = user.organization.name;
  const [live, setLive] = React.useState<{
    cached: string | undefined;
    session: string;
    name: string | undefined;
  }>({ cached, session, name: cached });
  if (cached !== live.cached) {
    // A new answer names it (or its query left the cache: keep the last name).
    setLive({ cached, session, name: cached ?? live.name });
  } else if (session !== live.session) {
    // The server rendered the shell again: its name is the newer one.
    setLive({ cached, session, name: undefined });
  }
  const name = live.session === session ? live.name : undefined;
  const value = React.useMemo(
    () => (name === undefined ? user : withOrganizationName(user, name)),
    [user, name],
  );
  return <CurrentUserProvider user={value}>{children}</CurrentUserProvider>;
}
