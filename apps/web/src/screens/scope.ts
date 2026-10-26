"use client";

import { useCurrentUser, type SessionUser } from "@/components/current-user";

/** What a list or count request sends as `organization`: `all`, or one organization's id. */
export type ScopeParam = "all" | (string & {});

/** The `organization` parameter for `user`'s scope ("All organizations" → `all`). */
export function scopeParam(user: Pick<SessionUser, "scope" | "organization">): ScopeParam {
  return user.scope === "all" ? "all" : user.organization.id;
}

/**
 * The `organization` parameter every list and count request of the screens sends:
 * `all` under "All organizations", else the active organization's id. Queries key by it.
 */
export function useScopeParam(): ScopeParam {
  return scopeParam(useCurrentUser());
}
