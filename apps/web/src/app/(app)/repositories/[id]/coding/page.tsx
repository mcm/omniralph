import type { Metadata } from "next";
import { RepositorySettingsView } from "../settings/repository-settings-view";

export const metadata: Metadata = { title: "Repository coding settings · Omniralph" };

export default function RepositoryCodingPage() {
  return <RepositorySettingsView tab="coding" />;
}
