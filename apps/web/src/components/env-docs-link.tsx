import { ENV_DOCS_URL } from "@/lib/docs";

/** "docs/env.md", linked to the page that describes every server environment variable. */
export function EnvDocsLink() {
  return (
    <a href={ENV_DOCS_URL} target="_blank" rel="noreferrer" className="inline-link">
      docs/env.md
    </a>
  );
}
