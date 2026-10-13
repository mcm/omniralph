import type { Metadata } from "next";
import { renderRepositorySettings } from "../repository-settings-page";

export const metadata: Metadata = { title: "Repository coding settings · Omniralph" };

export default async function RepositoryCodingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return renderRepositorySettings(params, "coding");
}
