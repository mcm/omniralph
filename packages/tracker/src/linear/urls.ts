/** Linear issue URLs: `https://linear.app/<workspace>/issue/<identifier>/<slug>`. */

const WORKSPACE_URL = /^(https:\/\/linear\.app\/[^/]+)\/issue\//;

/**
 * The URL of another issue of the same Linear workspace, derived from one issue's URL; null
 * when that URL isn't a Linear issue URL.
 */
export function linearSiblingIssueUrl(issueUrl: string, identifier: string): string | null {
  const workspace = WORKSPACE_URL.exec(issueUrl)?.[1];
  return workspace ? `${workspace}/issue/${identifier}` : null;
}
