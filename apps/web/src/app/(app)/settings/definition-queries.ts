"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import type { Invalidation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  agentDetailSchema,
  agentListSchema,
  definitionPath,
  harnessChoicesSchema,
  taskDetailSchema,
  taskFormOptionsSchema,
  taskListSchema,
} from "@/lib/api/definitions";
import type { QueryKeys } from "@/lib/api/keys";
import { definitionKeys } from "@/lib/api/settings-keys";

/**
 * Settings › Agents and Settings › Tasks, live: saves publish `settings` change events
 * (sections `agent_definitions`, `task_definitions`), and so do the agents' reported
 * models and installables the form options show (`@/lib/live/invalidations`).
 */
export { definitionKeys };

/**
 * What creating, changing or cloning an agent or a task affects: every agent and task query
 * (names, "Used by", form options), cached ones too, so the page a save navigates to never
 * renders its stale copy; and the settings that pick tasks (repositories, chat tasks).
 */
export function definitionsChanged(keys: QueryKeys): Invalidation[] {
  const { agents, tasks } = definitionKeys(keys);
  return [
    { queryKey: agents.all, refetchType: "all" },
    { queryKey: tasks.all, refetchType: "all" },
    keys.repositories.all,
    keys.connections.detail("integrations"),
  ];
}

/**
 * What deleting an agent or a task affects: as `definitionsChanged`, but the deleted
 * definition's own detail isn't refetched (it would 404 on the page being left).
 */
export function definitionDeleted(kind: "agents" | "tasks") {
  return (keys: QueryKeys): Invalidation[] => {
    const all = definitionKeys(keys);
    const other = kind === "agents" ? all.tasks : all.agents;
    return [
      { queryKey: all[kind].list, refetchType: "all" },
      all[kind].formOptions,
      { queryKey: other.all, refetchType: "all" },
      keys.repositories.all,
      keys.connections.detail("integrations"),
    ];
  };
}

/** The organization's agents (`GET /api/ui/agents`). */
export function useAgentList() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: definitionKeys(keys).agents.list,
    queryFn: ({ signal }) =>
      api.get("/api/ui/agents", agentListSchema, { organizationId: organization.id, signal }),
  });
}

/** One agent and the tasks running on it (`GET /api/ui/agents/{id}`). */
export function useAgentDetail(id: string, { enabled = true } = {}) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: definitionKeys(keys).agents.detail(id),
    queryFn: ({ signal }) =>
      api.get(definitionPath("agents", id), agentDetailSchema, {
        organizationId: organization.id,
        signal,
      }),
    enabled,
  });
}

/** What the agent form picks models and installables from (admins). */
export function useAgentFormOptions({ enabled = true } = {}) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: definitionKeys(keys).agents.formOptions,
    queryFn: ({ signal }) =>
      api.get("/api/ui/agents/form-options", harnessChoicesSchema, {
        organizationId: organization.id,
        signal,
      }),
    enabled,
  });
}

/** The organization's tasks (`GET /api/ui/tasks`). */
export function useTaskList() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: definitionKeys(keys).tasks.list,
    queryFn: ({ signal }) =>
      api.get("/api/ui/tasks", taskListSchema, { organizationId: organization.id, signal }),
  });
}

/** One task, what its runs need and what uses it (`GET /api/ui/tasks/{id}`). */
export function useTaskDetail(id: string, { enabled = true } = {}) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: definitionKeys(keys).tasks.detail(id),
    queryFn: ({ signal }) =>
      api.get(definitionPath("tasks", id), taskDetailSchema, {
        organizationId: organization.id,
        signal,
      }),
    enabled,
  });
}

/** What the task form picks from (admins). */
export function useTaskFormOptions({ enabled = true } = {}) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: definitionKeys(keys).tasks.formOptions,
    queryFn: ({ signal }) =>
      api.get("/api/ui/tasks/form-options", taskFormOptionsSchema, {
        organizationId: organization.id,
        signal,
      }),
    enabled,
  });
}
