/** Longest organization name accepted. */
export const MAX_ORGANIZATION_NAME_LENGTH = 100;

/** Trims an organization name; returns an error message when it's empty or too long. */
export function checkOrganizationName(name: unknown): { name: string } | { error: string } {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return { error: "Enter a name for the organization." };
  if (trimmed.length > MAX_ORGANIZATION_NAME_LENGTH) {
    return { error: `Use at most ${MAX_ORGANIZATION_NAME_LENGTH} characters.` };
  }
  return { name: trimmed };
}
