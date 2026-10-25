"use client";

import * as React from "react";
import type { Role } from "@/lib/auth/roles";

/** Serializable view of the signed-in user, provided by the `(app)` layout. */
export interface SessionUser {
  id: string;
  /** The active organization. */
  organization: { id: string; name: string };
  /** The user's role in the active organization. */
  role: Role;
  /**
   * This device's organization scope: `all` shows every organization in `organizations`
   * ("All organizations"), `single` the active one. Server actions and `/api/ui` act on
   * the active organization either way.
   */
  scope: "single" | "all";
  /** Every organization the user belongs to, with their role in each, ordered by name. */
  organizations: { id: string; name: string; role: Role }[];
  name: string | null;
  email: string | null;
  image: string | null;
}

const CurrentUserContext = React.createContext<SessionUser | null>(null);

export function CurrentUserProvider({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  return <CurrentUserContext.Provider value={user}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): SessionUser {
  const user = React.useContext(CurrentUserContext);
  if (!user) throw new Error("useCurrentUser must be used inside the signed-in app shell");
  return user;
}
