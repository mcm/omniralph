"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { harnessDefaultsSchema, hostToolCatalogSchema } from "@/lib/api/harness-defaults";
import type { QueryKeys } from "@/lib/api/keys";

/** The keys of Settings › Harness defaults' tabs. */
export const harnessDefaultsKeys = (keys: QueryKeys) => ({
  defaults: keys.settings.detail("harness-defaults"),
  hostTools: keys.settings.detail("host-tools"),
});

/** The organization's harness defaults, live (`GET /api/ui/harness-defaults`, admins). */
export function useHarnessDefaults() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: harnessDefaultsKeys(keys).defaults,
    queryFn: ({ signal }) =>
      api.get("/api/ui/harness-defaults", harnessDefaultsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The organization's host tool catalog, live (`GET /api/ui/host-tools`, admins). */
export function useHostToolCatalog() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: harnessDefaultsKeys(keys).hostTools,
    queryFn: ({ signal }) =>
      api.get("/api/ui/host-tools", hostToolCatalogSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * What a defaults change affects: this tab, every harness query (the list's and detail's
 * desired version and update state, and the concurrency they inherit) and every
 * repository query (the harnesses' task types and version a repository's Harnesses tab shows).
 */
export const harnessDefaultsChanged = (keys: QueryKeys) => [
  harnessDefaultsKeys(keys).defaults,
  keys.harnesses.all,
  keys.repositories.all,
];

/**
 * What a host tool catalog change affects: this tab, every harness's Host tools tab and the
 * task editor's host tool choices.
 */
export const hostToolsChanged = (keys: QueryKeys) => [
  harnessDefaultsKeys(keys).hostTools,
  keys.harnesses.all,
  keys.settings.detail("tasks"),
];
