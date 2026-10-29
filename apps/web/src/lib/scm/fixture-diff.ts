import "server-only";
import type { Database, ScmConnection } from "@omniralph/db";
import type { CommitDiff, ScmAdapter } from "@omniralph/scm";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { scmAdapterFor } from "./adapters";

/**
 * Whether commit diffs and the add-repo picker's list of fixture connections come from the
 * fixture code host instead of GitHub or GitLab: only outside production with
 * `OMNIRALPH_FIXTURE_SCM=1`, which the fixture environment (`scripts/fixtures`) sets so
 * screenshots show a story's diff and the picker's repos.
 */
export function fixtureScmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.OMNIRALPH_FIXTURE_SCM === "1";
}

/** A fixture connection's: its external ID starts with `fixture`, as the seed's do. */
export const isFixtureConnection = (connection: ScmConnection) =>
  connection.externalId?.startsWith("fixture") ?? false;

/**
 * `scmAdapterFor` for commit diffs, with the fixture code host for fixture connections: it
 * answers every commit with the same small diff. Any other connection gets its real adapter.
 */
export function fixtureDiffAdapterFor(
  db: Database,
  connection: ScmConnection,
): Pick<ScmAdapter, "getCommitDiff"> {
  if (!isFixtureConnection(connection)) return scmAdapterFor(db, connection);
  return {
    getCommitDiff: async (repo, sha) => fixtureCommitDiff(connection, repo.fullPath, sha),
  };
}

function fixtureCommitDiff(connection: ScmConnection, fullPath: string, sha: string): CommitDiff {
  const repo = repositoryWebUrl(connection.provider, connection.baseUrl, fullPath);
  return {
    sha,
    url: connection.provider === "gitlab" ? `${repo}/-/commit/${sha}` : `${repo}/commit/${sha}`,
    truncated: false,
    files: [
      {
        path: "src/app/onboarding/invite-step.tsx",
        previousPath: null,
        status: "added",
        additions: 9,
        deletions: 0,
        truncated: false,
        patch: [
          "@@ -0,0 +1,9 @@",
          '+import { InviteForm } from "@/components/invite-form";',
          "+",
          "+/** Onboarding's last step: invite teammates by email. */",
          "+export function InviteStep({ organizationId }: { organizationId: string }) {",
          "+  return (",
          '+    <InviteForm organizationId={organizationId} submitLabel="Send invitations" />',
          "+  );",
          "+}",
          "+",
        ].join("\n"),
      },
      {
        path: "src/lib/invitations/domain.ts",
        previousPath: "src/lib/invitations/email-domain.ts",
        status: "renamed",
        additions: 3,
        deletions: 2,
        truncated: false,
        patch: [
          "@@ -4,8 +4,9 @@ export function allowedDomain(",
          "   email: string,",
          "   domains: readonly string[],",
          " ): boolean {",
          '-  const domain = email.split("@")[1];',
          "-  return domains.includes(domain);",
          '+  const domain = email.split("@").at(-1)?.toLowerCase();',
          "+  if (!domain) return false;",
          "+  return domains.some((d) => d.toLowerCase() === domain);",
          " }",
        ].join("\n"),
      },
      {
        path: "public/onboarding/invite.png",
        previousPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        truncated: false,
        patch: null,
      },
    ],
  };
}
