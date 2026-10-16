import type { Metadata } from "next";
import { GitHubReposView } from "./github-repos-view";

export const metadata: Metadata = { title: "GitHub repositories · Omniralph" };

export default function GitHubInstallationPage() {
  return <GitHubReposView />;
}
