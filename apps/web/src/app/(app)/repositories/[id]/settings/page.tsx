import type { Metadata } from "next";
import { renderRepositorySettings } from "../repository-settings-page";

export const metadata: Metadata = { title: "Repository review settings · Omniralph" };

export default async function RepositorySettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return renderRepositorySettings(params, "settings");
}
