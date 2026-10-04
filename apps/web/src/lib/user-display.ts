/** Up to two initials from the name (or the email's local part) for avatar fallbacks. */
export function userInitials(user: { name: string | null; email: string | null }): string {
  const source = user.name?.trim() || user.email?.split("@")[0]?.trim() || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? source;
  const last = parts[parts.length - 1] ?? "";
  const letters = parts.length > 1 ? `${first.charAt(0)}${last.charAt(0)}` : source.slice(0, 2);
  return letters.toUpperCase();
}

/** Name to show for a user: their name, else their email, else a placeholder. */
export function userDisplayName(user: { name: string | null; email: string | null }): string {
  return user.name?.trim() || user.email || "Unknown user";
}
