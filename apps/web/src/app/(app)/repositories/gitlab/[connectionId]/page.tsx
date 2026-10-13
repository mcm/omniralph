import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connectionCredentials, getScmConnection, listConnectionRepositories } from "@omniralph/db";
import { GitLabSetupClient, MAX_LISTED_GITLAB_PROJECTS } from "@omniralph/scm";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { GitLabProjectsView, type GitLabProjectRow } from "./gitlab-projects-view";

export const metadata: Metadata = { title: "GitLab projects · Omniralph" };

export default async function GitLabConnectionPage({
  params,
}: {
  params: Promise<{ connectionId: string }>;
}) {
  const { connectionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) notFound();
  await enterResourceOrganization(
    await requirePageUser(),
    "scm_connection",
    connectionId,
    `/repositories/gitlab/${connectionId}`,
  );
  const admin = await requirePageUser("admin");
  const db = getDb();
  const connection = await getScmConnection(db, admin.organization.id, connectionId);
  if (!connection || connection.provider !== "gitlab") notFound();

  const connected = new Map(
    (await listConnectionRepositories(db, connection.id)).map((repo) => [repo.externalId, repo]),
  );
  let projects: GitLabProjectRow[] = [];
  let error: string | null = null;
  try {
    const { token } = connectionCredentials<{ token: string }>(connection);
    const listed = await new GitLabSetupClient({
      baseUrl: connection.baseUrl,
      token,
    }).listProjects();
    projects = listed.map((project) => {
      const row = connected.get(String(project.id));
      return {
        id: project.id,
        fullPath: project.fullPath,
        private: project.visibility !== "public",
        htmlUrl: project.webUrl,
        enabled: Boolean(row && !row.disconnectedAt && row.effective.review),
      };
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return (
    <GitLabProjectsView
      connectionId={connection.id}
      name={connection.name}
      projects={projects}
      truncated={projects.length >= MAX_LISTED_GITLAB_PROJECTS}
      error={error}
    />
  );
}
