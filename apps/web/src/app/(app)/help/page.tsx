import type { Metadata } from "next";
import { HelpView } from "@/screens/help/help-view";

export const metadata: Metadata = { title: "Help · Omniralph" };

/** Help: the keyboard shortcuts, from the registry (`src/lib/shortcuts.ts`). Any member may read it. */
export default function HelpPage() {
  return <HelpView />;
}
