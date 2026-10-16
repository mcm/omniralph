"use client";

import { InlineCode } from "@iamthemcmaster/ui";
import { IconBrandGitlab } from "@tabler/icons-react";
import { EnvDocsLink } from "@/components/env-docs-link";
import type { ListingFailure } from "@/lib/scm/listing-error";
import { RepoSelectionView } from "../../repo-selection-view";

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

/** Picks the projects of a GitLab connection (the route's `connectionId`) that are reviewed. */
export function GitLabProjectsView() {
  return (
    <RepoSelectionView
      provider="gitlab"
      breadcrumb={(name) => `GitLab · ${name}`}
      intro="Pick the projects of this GitLab connection that Omniralph reviews. Selecting a project adds a webhook for merge request, comment and pipeline events to it."
      listedDescription={(listing) => (
        <>
          Projects where the bot token&apos;s user has the Maintainer role (or Owner) are listed;
          archived projects aren&apos;t. To add a project, make the bot a Maintainer of it on
          GitLab.
          {listing?.truncated && ` Only the first ${listing.repos.length} projects are shown.`}
        </>
      )}
      emptyIcon={<IconBrandGitlab size={24} />}
      emptyDescription="The bot token's user isn't a Maintainer of any project."
      describeError={describeGitLabError}
      savedMessage={(name) => `Saved projects for ${name}`}
    />
  );
}
