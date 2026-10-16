"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import {
  harnessDetailSchema,
  harnessHostToolsSchema,
  harnessInstallablesSchema,
} from "@/lib/api/harnesses";
import type { QueryKeys } from "@/lib/api/keys";

/** The page asking, so a harness of another organization switches to it and comes back here. */
function currentPage(): string | undefined {
  return typeof window === "undefined"
    ? undefined
    : `${window.location.pathname}${window.location.search}`;
}

/** A harness and what all its tabs show, live (`GET /api/ui/harnesses/{id}`). */
export function useHarnessDetail(harnessId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.harnesses.detail(harnessId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/harnesses/${harnessId}`, harnessDetailSchema, {
        params: { next: currentPage() },
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The Installables tab: reported installables and recent install jobs, live. */
export function useHarnessInstallables(harnessId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.harnesses.part(harnessId, "installables"),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/harnesses/${harnessId}/installables`, harnessInstallablesSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The Host tools tab: the catalog's host tools with this harness's paths and reports, live. */
export function useHarnessHostTools(harnessId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.harnesses.part(harnessId, "host-tools"),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/harnesses/${harnessId}/host-tools`, harnessHostToolsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * What a change to a harness can affect: every harness list and detail, and the
 * repositories pages (which show pins and the harnesses serving them).
 */
export function harnessChanged(keys: QueryKeys): QueryKey[] {
  return [keys.harnesses.all, keys.repositories.all];
}
