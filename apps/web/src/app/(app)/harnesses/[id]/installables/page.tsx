import type { Metadata } from "next";
import { renderHarnessPage } from "../harness-page";

export const metadata: Metadata = { title: "Harness installables · Omniralph" };

export default async function HarnessInstallablesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return renderHarnessPage(params, "installables");
}
