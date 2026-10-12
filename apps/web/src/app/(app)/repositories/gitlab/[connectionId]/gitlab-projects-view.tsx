"use client";

import { IconBrandGitlab } from "@tabler/icons-react";
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
      errorTitle="Couldn't load the GitLab projects"
      errorCause="Omniralph couldn't get the project list from GitLab. Usually the GitLab host can't be reached from the server (a wrong URL, DNS or a firewall), or the bot's access token has expired or was revoked. Check the host and the token, then retry."
      repos={projects}
      error={error}
      save={(selectedIds) => saveGitLabProjects(connectionId, selectedIds)}
      savedMessage={`Saved projects for ${name}`}
    />
  );
}
