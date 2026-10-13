import type { Metadata } from "next";
import { renderRepositorySettings } from "../repository-settings-page";

export const metadata: Metadata = { title: "Repository Coding Tasks · Omniralph" };

export default async function RepositoryCodingTasksPage({ params }: { params: Promise<{ id: string }> }) {
  return renderRepositorySettings(params, "coding-tasks");
}
