import type { Metadata } from "next";
import { getIntegration } from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { linearOAuthConfig } from "@/lib/linear/oauth";
import { IntegrationsView, type LinearNotice } from "./integrations-view";

export const metadata: Metadata = { title: "Integrations · Omniralph" };

const NOTICES: Record<string, LinearNotice> = {
  connected: "connected",
  denied: "denied",
  invalid: "invalid",
  invalid_state: "invalid_state",
  other_organization: "other_organization",
  not_configured: "not_configured",
  error: "error",
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ linear?: string }>;
}) {
  const admin = await requirePageUser("admin");
  const { linear } = await searchParams;
  const integration = await getIntegration(getDb(), admin.organization.id, "linear");

  return (
    <IntegrationsView
      linear={
        integration
          ? {
              name: integration.name,
              workspaceId: integration.externalId,
              connectedAt: integration.updatedAt.toISOString(),
            }
          : null
      }
      linearConfigured={linearOAuthConfig() !== null}
      notice={linear ? (NOTICES[linear] ?? null) : null}
    />
  );
}
