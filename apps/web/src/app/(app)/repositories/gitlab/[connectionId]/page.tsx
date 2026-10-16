import type { Metadata } from "next";
import { GitLabProjectsView } from "./gitlab-projects-view";

export const metadata: Metadata = { title: "GitLab projects · Omniralph" };

export default function GitLabConnectionPage() {
  return <GitLabProjectsView />;
}
