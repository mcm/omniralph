"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { integrationsSettingsSchema } from "@/lib/api/integrations";
import type { QueryKeys } from "@/lib/api/keys";

/** The organization's integrations, live (`GET /api/ui/integrations`, admins). */
export function useIntegrations() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.connections.detail("integrations"),
    queryFn: ({ signal }) =>
      api.get("/api/ui/integrations", integrationsSettingsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * What an integration change affects: this page and every other connection query (the
 * repository Coding tab's Linear status), runs (whether Linear is connected) and the
 * settings that list what uses a task (chat tasks).
 */
export const integrationsChanged = (keys: QueryKeys) => [
  keys.connections.all,
  keys.runs.all,
  keys.settings.all,
];
