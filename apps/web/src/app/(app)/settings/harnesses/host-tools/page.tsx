import type { Metadata } from "next";
import { renderHarnessSettings } from "../harness-settings-page";

export const metadata: Metadata = { title: "Host tools · Harness defaults · Omniralph" };

export default async function HostToolsSettingsPage() {
  return renderHarnessSettings("host-tools");
}
