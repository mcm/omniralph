/** "NETbuilder", "Acme and NETbuilder", "Acme, Beta and NETbuilder" (no serial comma). */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
