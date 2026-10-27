"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import type { MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { playbookKeys } from "@/lib/api/playbook-keys";
import {
  playbookDetailSchema,
  playbookFormOptionsSchema,
  playbookListSchema,
  playbookPath,
  type PlaybookDetail,
  type PlaybookFormOptions,
  type PlaybookList,
  type PlaybookSummary,
  type SavedPlaybook,
} from "@/lib/api/playbooks";

/**
 * The organization's playbooks (`GET /api/ui/playbooks`), for Advanced › Playbooks. A live
 * query: a playbook saved or deleted (`settings` section `playbooks`) or a repo's bindings
 * changing (`settings` section `repository.playbooks`, `repository`) refetches it.
 */
export function usePlaybooks() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<PlaybookList>({
    queryKey: playbookKeys(keys).list,
    queryFn: ({ signal }) =>
      api.get("/api/ui/playbooks", playbookListSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** Playbook `id` with what its runs need and what uses it (`GET /api/ui/playbooks/{id}`); live like the list. */
export function usePlaybook(id: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<PlaybookDetail>({
    queryKey: playbookKeys(keys).detail(id),
    queryFn: ({ signal }) =>
      api.get(playbookPath(id), playbookDetailSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * What the playbook editor offers (`GET /api/ui/playbooks/form-options`, admins): live, as a
 * playbook change or an agent reporting new models or MCP servers refetches it.
 */
export function usePlaybookFormOptions() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<PlaybookFormOptions>({
    queryKey: playbookKeys(keys).formOptions,
    queryFn: ({ signal }) =>
      api.get("/api/ui/playbooks/form-options", playbookFormOptionsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** `list` with `summary` in place of its row, or added: built-ins first, then the rest by name. */
export function withPlaybook(list: PlaybookList, summary: PlaybookSummary): PlaybookList {
  const others = list.playbooks.filter((row) => row.id !== summary.id);
  const builtins = others.filter((row) => row.builtin);
  const custom = [...others.filter((row) => !row.builtin), summary].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { playbooks: [...builtins, ...custom] };
}

/** `list` without playbook `id`. */
export function withoutPlaybook(list: PlaybookList, id: string): PlaybookList {
  return { playbooks: list.playbooks.filter((row) => row.id !== id) };
}

/** Writes a created, cloned or saved playbook into the cached list and its detail. */
export async function writeSavedPlaybook(cache: MutationCache, saved: SavedPlaybook) {
  const keys = playbookKeys(cache.keys);
  await cache.set<PlaybookDetail>(keys.detail(saved.id), () => saved.detail, { exact: true });
  await cache.set<PlaybookList>(
    keys.list,
    (previous) => previous && withPlaybook(previous, saved.summary),
    { exact: true },
  );
}

/** Takes a deleted playbook out of the cached list. */
export async function writeDeletedPlaybook(cache: MutationCache, id: string) {
  await cache.set<PlaybookList>(
    playbookKeys(cache.keys).list,
    (previous) => previous && withoutPlaybook(previous, id),
    { exact: true },
  );
}
