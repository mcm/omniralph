import type { QueryKeys } from "./keys";

/**
 * Query keys of Settings › Agents and Settings › Tasks. Every query of one kind shares a
 * prefix (`definitionKeys(keys).agents.all`), so a change refetches its lists, details and
 * form options. Shared by the pages' queries and the live data layer (`@/lib/live`).
 */
export function definitionKeys(keys: QueryKeys) {
  const kind = (name: "agents" | "tasks") => ({
    all: keys.settings.detail(name),
    list: keys.settings.part(name, "list"),
    detail: (id: string) => keys.settings.part(name, "detail", { id }),
    formOptions: keys.settings.part(name, "form-options"),
  });
  return { agents: kind("agents"), tasks: kind("tasks") };
}

/** The key of Settings › Review profiles. */
export const reviewProfilesKey = (keys: QueryKeys) => keys.settings.detail("review-profiles");
