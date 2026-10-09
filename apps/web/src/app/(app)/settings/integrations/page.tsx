import type { Metadata } from "next";
import { getIntegration, getUserById, listChatConnections } from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { slackOAuthConfig } from "@/lib/chat/slack-oauth";
import { getDb } from "@/lib/db";
import { linearOAuthConfig } from "@/lib/linear/oauth";
import { IntegrationsView, type IntegrationNotice } from "./integrations-view";

export const metadata: Metadata = { title: "Integrations · Omniralph" };

const NOTICES: Record<string, IntegrationNotice> = {
  connected: "connected",
  denied: "denied",
  invalid: "invalid",
  invalid_state: "invalid_state",
  other_organization: "other_organization",
  not_configured: "not_configured",
  error: "error",
};

const toNotice = (value: string | undefined) => (value ? (NOTICES[value] ?? null) : null);

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ linear?: string; slack?: string }>;
}) {
  const admin = await requirePageUser("admin");
  const { linear, slack } = await searchParams;
  const db = getDb();
  const [integration, chatConnections] = await Promise.all([
    getIntegration(db, admin.organization.id, "linear"),
    listChatConnections(db, admin.organization.id),
  ]);
  const slackConnections = chatConnections.filter((c) => c.platform === "slack");
  // The installer may have left the organization since, so look them up as a user.
  const installers = new Map(
    await Promise.all(
      [...new Set(slackConnections.map((c) => c.installedByUserId))]
        .filter((id): id is string => id !== null)
        .map(async (id) => {
          const user = await getUserById(db, id);
          return [id, user ? (user.name ?? user.email) : null] as const;
        }),
    ),
  );

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
      notice={toNotice(linear)}
      slack={slackConnections.map((c) => ({
        id: c.id,
        name: c.name,
        workspaceId: c.externalId,
        installedBy: (c.installedByUserId && installers.get(c.installedByUserId)) ?? null,
        connectedAt: c.updatedAt.toISOString(),
      }))}
      slackConfigured={slackOAuthConfig() !== null}
      slackNotice={toNotice(slack)}
    />
  );
}
