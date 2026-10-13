"use client";

import { InlineCode } from "@iamthemcmaster/ui";
import { IconBrandGitlab } from "@tabler/icons-react";
import { EnvDocsLink } from "@/components/env-docs-link";
import type { ListingFailure } from "@/lib/scm/listing-error";
import { saveGitLabProjects } from "../../actions";
import { RepoSelectionView, type SelectableRepoRow } from "../../repo-selection-view";

export type GitLabProjectRow = SelectableRepoRow;

interface GitLabProjectsViewProps {
  connectionId: string;
  /** Connection name, `<bot user> @ <host>`. */
  name: string;
  projects: GitLabProjectRow[];
  /** Whether the list was cut off at the most projects listed. */
  truncated: boolean;
  error: string | null;
}

function describeGitLabError(failure: ListingFailure) {
  switch (failure.kind) {
    case "config":
      return {
        title: "The server is missing a setting",
        cause: (
          <>
            <InlineCode>{failure.variable}</InlineCode> is not set. Set it on the server and restart
            it (see <EnvDocsLink />
            ); retrying before then won&apos;t help.
          </>
        ),
      };
    case "auth":
      return {
        title: "GitLab refused the bot token",
        cause:
          "The bot's access token has expired or was revoked, or it lost the api scope. Create a new token for the same user on GitLab and use Connect GitLab on Repositories with it: the connection keeps its projects.",
      };
    case "network":
      return {
        title: "Couldn't reach the GitLab host",
        cause:
          "The server couldn't connect to the GitLab host: a wrong URL, DNS, a firewall or the host is down. Check that the server can reach it, then retry.",
      };
    default:
      return {
        title: "Couldn't load the GitLab projects",
        cause:
          "Omniralph couldn't get the project list from GitLab. Usually the GitLab host can't be reached from the server (a wrong URL, DNS or a firewall), or the bot's access token has expired or was revoked. Check the host and the token, then retry.",
      };
  }
}

export function GitLabProjectsView({
  connectionId,
  name,
  projects,
  truncated,
  error,
}: GitLabProjectsViewProps) {
  return (
    <RepoSelectionView
      breadcrumb={`GitLab · ${name}`}
      title={name}
      intro="Pick the projects of this GitLab connection that Omniralph reviews. Selecting a project adds a webhook for merge request, comment and pipeline events to it."
      listedDescription={
        <>
          Projects where the bot token&apos;s user has the Maintainer role (or Owner) are listed;
          archived projects aren&apos;t. To add a project, make the bot a Maintainer of it on
          GitLab.
          {truncated && ` Only the first ${projects.length} projects are shown.`}
        </>
      }
      emptyIcon={<IconBrandGitlab size={24} />}
      emptyDescription="The bot token's user isn't a Maintainer of any project."
      describeError={describeGitLabError}
      repos={projects}
      error={error}
      save={(selectedIds) => saveGitLabProjects(connectionId, selectedIds)}
      savedMessage={`Saved projects for ${name}`}
    />
  );
}
