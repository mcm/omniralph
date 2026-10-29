"use client";

import { IconLock } from "@tabler/icons-react";
import { useCurrentUser } from "@/components/current-user";
import { hasRole } from "@/lib/auth/roles";
import "./admins-only-note.css";

/**
 * Says once, at the top of a page a member sees read-only, why its controls are disabled:
 * "Only admins can change these settings." The page keeps its controls disabled (or hidden).
 */
export function AdminsOnlyNote({ what = "these settings" }: { what?: string }) {
  return (
    <p className="or-admins-only">
      <IconLock className="or-admins-only__icon" size={14} stroke={1.75} aria-hidden="true" />
      Only admins can change {what}.
    </p>
  );
}

/** `AdminsOnlyNote` for a member of the active organization; nothing for its admins. */
export function MemberReadOnlyNote() {
  return hasRole(useCurrentUser(), "admin") ? null : <AdminsOnlyNote />;
}
