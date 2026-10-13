/** The repository's docs on GitHub, for links from the panel (e.g. `docsUrl("env.md")`). */
const DOCS_BASE_URL = "https://github.com/mcm/omniralph/blob/main/docs/";

export function docsUrl(path: string): string {
  return `${DOCS_BASE_URL}${path}`;
}

/** Where every server environment variable is described. */
export const ENV_DOCS_URL = docsUrl("env.md");
