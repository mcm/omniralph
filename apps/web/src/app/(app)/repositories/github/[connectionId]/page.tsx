import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getScmConnection, listConnectionRepositories, type ScmConnection } from "@omniralph/db";
import { getInstallation, listInstallationRepos } from "@omniralph/scm";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getGitHubAppAuth } from "@/lib/scm/github-app";
import { GitHubReposView, type InstallationRepoRow } from "./github-repos-view";

export const metadata: Metadata = { title: "GitHub repositories · Omniralph" };

export default async function GitHubInstallationPage({
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
    `/repositories/github/${connectionId}`,
  );
  const admin = await requirePageUser("admin");
  const connection = await getScmConnection(getDb(), admin.organization.id, connectionId);
  if (!connection || connection.provider !== "github" || !connection.externalId) notFound();

  // The page renders right away; the list streams in once GitHub answers.
  return (
    <Suspense
      fallback={
        <GitHubReposView
          connectionId={connection.id}
          account={connection.name}
          manageUrl={null}
          repos={null}
          error={null}
        />
      }
    >
      <InstallationRepos connection={connection} />
    </Suspense>
  );
}

/** The installation's repositories from GitHub, marked with the ones connected here. */
async function InstallationRepos({ connection }: { connection: ScmConnection }) {
  const installationId = Number(connection.externalId);
  const connected = new Map(
    (await listConnectionRepositories(getDb(), connection.id)).map((repo) => [
      repo.externalId,
      repo,
    ]),
  );
  let loaded: { account: string; manageUrl: string | null; repos: InstallationRepoRow[] };
  let error: string | null = null;
  try {
    const auth = getGitHubAppAuth();
    const [installation, repos] = await Promise.all([
      getInstallation(auth, installationId),
      listInstallationRepos(auth, installationId),
    ]);
    loaded = {
      account: installation.account,
      manageUrl: installation.htmlUrl,
      repos: repos.map((repo) => {
        const row = connected.get(String(repo.id));
        return {
          id: repo.id,
          fullPath: repo.fullPath,
          private: repo.private,
          htmlUrl: repo.htmlUrl,
          enabled: Boolean(row && !row.disconnectedAt && row.enabled),
        };
      }),
    };
  } catch (cause) {
    loaded = { account: connection.name, manageUrl: null, repos: [] };
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return <GitHubReposView connectionId={connection.id} {...loaded} error={error} />;
}
