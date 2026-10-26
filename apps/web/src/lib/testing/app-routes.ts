import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The App Router's `src/app` directory. */
const APP = join(__dirname, "../../app");

/** The URL pattern of every App Router route handler under `dir` (route groups dropped). */
function routePatterns(dir = APP): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routePatterns(path);
    if (name !== "route.ts") return [];
    const segments = relative(APP, dir)
      .split(sep)
      .filter((segment) => segment && !/^\(.*\)$/.test(segment));
    return [`/${segments.join("/")}`];
  });
}

/**
 * Whether an App Router route handler serves `path` (dynamic `[x]` and catch-all `[...x]`
 * segments match). For tests that check a removed route answers 404.
 */
export function servedByRouteHandler(path: string): boolean {
  const wanted = path.split("/").filter(Boolean);
  const matches = (segments: string[]) => {
    for (const [i, segment] of segments.entries()) {
      if (segment.startsWith("[[...")) return true;
      if (segment.startsWith("[...")) return wanted.length > i;
      if (i >= wanted.length) return false;
      if (!segment.startsWith("[") && segment !== wanted[i]) return false;
    }
    return segments.length === wanted.length;
  };
  return routePatterns().some((pattern) => matches(pattern.split("/").filter(Boolean)));
}
