// Whether `next dev` serves every `/api/ui` route handler. Turbopack's dev server can start
// without some of them in its entrypoints (the router matches the URL, Turbopack then throws
// "route not found" and Next answers its HTML not-found page): every page that calls one then
// shows a load error. `startFixturePanel` (environment.ts) checks before anything is captured.
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { SESSION_COOKIES } from "../../src/lib/auth/routes";

/** What fills a dynamic segment in a probe: a UUID, like the fixture IDs. */
const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

/**
 * The URL path to request for each route handler, from its file relative to `src/app`
 * (`api/ui/runs/[id]/session/route.ts` → `/api/ui/runs/<uuid>/session`): route groups and
 * optional catch-alls dropped, other dynamic segments filled. Sorted.
 */
export function probePaths(files: readonly string[]): string[] {
  return files
    .map((file) => file.split(sep).join("/"))
    .filter((file) => /(^|\/)route\.(ts|tsx|js|mjs)$/.test(file))
    .map((file) => {
      const segments = file
        .split("/")
        .slice(0, -1)
        .filter((segment) => !/^\(.*\)$/.test(segment) && !/^\[\[\.\.\..+\]\]$/.test(segment))
        .map((segment) => (/^\[.+\]$/.test(segment) ? PLACEHOLDER : segment));
      return `/${segments.join("/")}`;
    })
    .sort();
}

/**
 * Whether a response is Next's own not-found page, i.e. no route handler answered: a 404 in
 * HTML. A handler answers JSON (or nothing), whatever its status.
 */
export function isUnmatched(status: number, contentType: string | null): boolean {
  return status === 404 && /^text\/html\b/i.test(contentType ?? "");
}

/**
 * The `/api/ui` paths `next dev` at `baseUrl` doesn't route to their handler. Each is requested
 * once (a few at a time; the first request compiles it) with a session cookie that only gets
 * past `proxy.ts`: a handler answers 401 JSON, a missing one Next's HTML 404.
 */
export async function unservedApiRoutes(
  baseUrl: string,
  appDir: string,
  paths?: readonly string[],
): Promise<string[]> {
  const queue = [
    ...(paths ??
      probePaths(
        (await readdir(join(appDir, "api", "ui"), { recursive: true })).map((file) =>
          join("api", "ui", file),
        ),
      )),
  ];
  const unserved: string[] = [];
  const probe = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const response = await fetch(new URL(path, baseUrl), {
        headers: { cookie: `${SESSION_COOKIES[0]}=probe` },
        redirect: "manual",
        signal: AbortSignal.timeout(180_000),
      });
      await response.arrayBuffer();
      if (isUnmatched(response.status, response.headers.get("content-type"))) unserved.push(path);
    }
  };
  await Promise.all(Array.from({ length: 4 }, probe));
  return unserved.sort();
}
