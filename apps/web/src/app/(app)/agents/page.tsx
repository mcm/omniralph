import type { Metadata } from "next";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = { title: "Agents · Omniralph" };

export default function AgentsPage() {
  return <AgentsView />;
}
