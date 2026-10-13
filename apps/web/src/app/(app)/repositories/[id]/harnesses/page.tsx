import type { Metadata } from "next";
import { renderRepositorySettings } from "../repository-settings-page";

export const metadata: Metadata = { title: "Repository harnesses · Omniralph" };

export default async function RepositoryHarnessesPage({ params }: { params: Promise<{ id: string }> }) {
  return renderRepositorySettings(params, "harnesses");
}
