import type { Metadata } from "next";
import { RepositorySettingsView } from "../settings/repository-settings-view";

export const metadata: Metadata = { title: "Repository harnesses · Omniralph" };

export default function RepositoryHarnessesPage() {
  return <RepositorySettingsView tab="harnesses" />;
}
