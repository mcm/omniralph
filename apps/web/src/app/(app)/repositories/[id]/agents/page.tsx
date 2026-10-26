import type { Metadata } from "next";
import { RepositorySettingsView } from "../settings/repository-settings-view";

export const metadata: Metadata = { title: "Repository agents · Omniralph" };

export default function RepositoryAgentsPage() {
  return <RepositorySettingsView tab="agents" />;
}
