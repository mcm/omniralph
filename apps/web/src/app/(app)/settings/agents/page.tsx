import type { Metadata } from "next";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = { title: "Agents · Omniralph" };

/** The organization's agent definitions: built-ins first, then its own. Every member may look. */
export default function AgentsPage() {
  return <AgentsView />;
}
