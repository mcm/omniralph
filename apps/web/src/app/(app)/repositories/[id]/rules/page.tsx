import type { Metadata } from "next";
import { RulesView } from "./rules-view";

export const metadata: Metadata = { title: "Repository rules · Omniralph" };

export default function RepositoryRulesPage() {
  return <RulesView />;
}
