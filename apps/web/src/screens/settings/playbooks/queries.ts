"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { playbookKeys } from "@/lib/api/playbook-keys";
import {
  playbookDetailSchema,
  playbookListSchema,
  playbookPath,
  type PlaybookDetail,
  type PlaybookList,
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
