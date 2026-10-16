import type { Metadata } from "next";
import { RepositoriesView } from "./repositories-view";

export const metadata: Metadata = { title: "Repositories · Omniralph" };

export default function RepositoriesPage() {
  return <RepositoriesView />;
}
