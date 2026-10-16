import type { Metadata } from "next";
import { RepositorySettingsView } from "./repository-settings-view";

export const metadata: Metadata = { title: "Repository review settings · Omniralph" };

export default function RepositorySettingsPage() {
  return <RepositorySettingsView tab="settings" />;
}
