/** Splits a full path into its last segment and the path before it. */
export function splitRepositoryPath(fullPath: string): { name: string; group: string | null } {
  const slash = fullPath.lastIndexOf("/");
  return slash === -1
    ? { name: fullPath, group: null }
    : { name: fullPath.slice(slash + 1), group: fullPath.slice(0, slash) || null };
}
