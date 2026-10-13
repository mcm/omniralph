import type { Metadata } from "next";
import { renderHarnessPage } from "../harness-page";

export const metadata: Metadata = { title: "Harness host tools · Omniralph" };

export default async function HarnessHostToolsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return renderHarnessPage(params, "host-tools");
}
