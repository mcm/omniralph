import type { Metadata } from "next";
import { HarnessesView } from "./harnesses-view";

export const metadata: Metadata = { title: "Harnesses · Omniralph" };

export default function HarnessesPage() {
  return <HarnessesView />;
}
