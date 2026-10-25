import type { QueryKeys } from "./keys";

/**
 * Query keys of playbooks (`/api/ui/playbooks/**`). Every playbook query shares a prefix
 * (`playbookKeys(keys).all`), so a change refetches its list and details. Shared by the
 * pages' queries and the live data layer (`@/lib/live`).
 */
export function playbookKeys(keys: QueryKeys) {
  return {
    all: keys.settings.detail("playbooks"),
    list: keys.settings.part("playbooks", "list"),
    detail: (id: string) => keys.settings.part("playbooks", "detail", { id }),
  };
}
