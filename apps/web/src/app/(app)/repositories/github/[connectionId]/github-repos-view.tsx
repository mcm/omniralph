"use client";

import { InlineCode } from "@iamthemcmaster/ui";
import { IconBrandGithub, IconExternalLink } from "@tabler/icons-react";
import { EnvDocsLink } from "@/components/env-docs-link";
import type { ListingFailure } from "@/lib/scm/listing-error";
import { saveGitHubRepositories } from "../../actions";
import { RepoSelectionView, type SelectableRepoRow } from "../../repo-selection-view";

export type InstallationRepoRow = SelectableRepoRow;

interface GitHubReposViewProps {
  connectionId: string;
  account: string;
  /** Installation settings on GitHub (add or remove repositories there). */
  manageUrl: string | null;
  /** `null` while the installation's repositories are loading. */
  repos: InstallationRepoRow[] | null;
  error: string | null;
}

function describeGitHubError(failure: ListingFailure) {
  switch (failure.kind) {
    case "config":
      return {
        title: "The GitHub App isn't configured on the server",
        cause: (
          <>
            <InlineCode>{failure.variable}</InlineCode> is not set, so Omniralph can&apos;t sign in
            as the GitHub App. Set it on the server and restart it (see <EnvDocsLink />
            ); retrying before then won&apos;t help.
          </>
        ),
      };
    case "auth":
      return {
        title: "GitHub refused the GitHub App",
        cause:
          "GitHub didn't accept the app's credentials for this installation: the app was uninstalled or suspended on the account, or its private key or app ID on the server is wrong. Check the installation on GitHub and the server's GitHub App settings.",
      };
    case "network":
      return {
        title: "Couldn't reach GitHub",
        cause:
          "The server couldn't connect to the GitHub API (DNS, a firewall or a GitHub outage). Retry in a moment.",
      };
    default:
      return {
        title: "Couldn't load the installation",
        cause:
          "Omniralph couldn't get the installation's repositories from GitHub. Usually the GitHub App was uninstalled or suspended on the account, its private key or app ID on the server is wrong, or GitHub can't be reached. Check the installation on GitHub, then retry.",
      };
  }
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
              <a href={manageUrl} target="_blank" rel="noreferrer" className="repo-external-link">
                Change them on GitHub
                <IconExternalLink size={12} />
              </a>
            </>
          )}
        </>
      }
      emptyIcon={<IconBrandGithub size={24} />}
      emptyDescription="The installation can't access any repositories."
      describeError={describeGitHubError}
      repos={repos}
      error={error}
      save={(selectedIds) => saveGitHubRepositories(connectionId, selectedIds)}
      savedMessage={`Saved repositories for ${account}`}
    />
  );
}
