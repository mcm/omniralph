import type { Metadata } from "next";
import { JobsView } from "./jobs-view";

export const metadata: Metadata = { title: "Jobs · Omniralph" };

export default function JobsPage() {
  return <JobsView />;
}
