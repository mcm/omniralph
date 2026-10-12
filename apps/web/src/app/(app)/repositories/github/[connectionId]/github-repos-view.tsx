"use client";

import { IconBrandGithub, IconExternalLink } from "@tabler/icons-react";
import { saveGitHubRepositories } from "../../actions";
import { RepoSelectionView, type SelectableRepoRow } from "../../repo-selection-view";

export type InstallationRepoRow = SelectableRepoRow;

interface GitHubReposViewProps {
  connectionId: string;
  account: string;
  /** Installation settings on GitHub (add or remove repositories there). */
  manageUrl: string | null;
  repos: InstallationRepoRow[];
  error: string | null;
}

export function GitHubReposView({
  connectionId,
  account,
  manageUrl,
  repos,
  error,
}: GitHubReposViewProps) {
  return (
    <RepoSelectionView
      breadcrumb={`GitHub · ${account}`}
      title={account}
      intro="Pick the repositories of this GitHub App installation that Omniralph reviews."
      listedDescription={
        <>
          Only repositories the installation can access are listed.
          {manageUrl && (
            <>
              {" "}
              <a
                href={manageUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "var(--text-accent)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  whiteSpace: "nowrap",
                }}
              >
                Change them on GitHub
                <IconExternalLink size={12} />
              </a>
            </>
          )}
        </>
      }
      emptyIcon={<IconBrandGithub size={24} />}
      emptyDescription="The installation can't access any repositories."
      errorTitle="Couldn't load the installation"
      errorCause="Omniralph couldn't get the installation's repositories from GitHub. Usually the GitHub App was uninstalled or suspended on the account, its private key or app ID on the server is wrong, or GitHub can't be reached. Check the installation on GitHub, then retry."
      repos={repos}
      error={error}
      save={(selectedIds) => saveGitHubRepositories(connectionId, selectedIds)}
      savedMessage={`Saved repositories for ${account}`}
    />
  );
}
