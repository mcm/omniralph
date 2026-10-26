import { notFound } from "next/navigation";
import { CONNECTION_PROVIDERS, type ConnectionProvider } from "@/lib/api/connections";
import { ConnectionSettings } from "@/screens/settings/connection-settings";

function isProvider(value: string): value is ConnectionProvider {
  return (CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

/** Connections › one GitHub, GitLab, Linear, Slack or Discord connection of the organization. */
export default async function ConnectionSettingsPage({
  params,
}: {
  params: Promise<{ provider: string; id: string }>;
}) {
  const { provider, id } = await params;
  if (!isProvider(provider)) notFound();
  return <ConnectionSettings provider={provider} connectionId={id} />;
}
