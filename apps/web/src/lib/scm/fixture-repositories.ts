import "server-only";
import { listConnectionRepositories, type Database, type ScmConnection } from "@omniralph/db";
import type { SelectableRepositories } from "@/lib/api/repositories";
import { repositoryWebUrl } from "@/lib/repositories/web-url";

/** Repos the fixture code host lists that aren't added yet, under the connection's namespace. */
const NOT_ADDED = ["design-system", "infra"] as const;

/** Code-host IDs of the fixture listing: stable, so a reload keeps the same selection. */
const FIRST_ID = 9001;

/**
 * The add-repo picker's list for a fixture connection (with `fixtureScmEnabled()`), from the
 * fixture code host instead of GitHub or GitLab: the connection's seeded repos, marked added
 * unless disconnected, and two repos not added yet, so screenshots show the picker's happy path.
 */
export async function listFixtureRepositories(
  db: Database,
  connection: ScmConnection,
): Promise<SelectableRepositories> {
  const seeded = await listConnectionRepositories(db, connection.id);
  const namespace = seeded[0]?.fullPath.split("/")[0] ?? connection.name;
  const listed = [
    ...seeded.map((repo) => ({ fullPath: repo.fullPath, connected: !repo.disconnectedAt })),
    ...NOT_ADDED.map((name) => ({ fullPath: `${namespace}/${name}`, connected: false })),
  ].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  return {
    account: connection.provider === "github" ? namespace : connection.name,
    manageUrl: null,
    truncated: false,
    repos: listed.map((repo, index) => ({
      id: FIRST_ID + index,
      fullPath: repo.fullPath,
      private: true,
      htmlUrl: repositoryWebUrl(connection.provider, connection.baseUrl, repo.fullPath),
      connected: repo.connected,
    })),
  };
}
