import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every relative Markdown link in README.md, apps/*/README.md and docs/ (and every link to this
// repository's files on GitHub) points at a file that exists, and at a heading that exists in it.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const REPO_BLOB = "https://github.com/mcm/omniralph/blob/main/";

/** README.md, apps/*\/README.md and every Markdown file under docs/, relative to the root. */
function markdownFiles(): string[] {
  const files = ["README.md"];
  for (const app of readdirSync(path.join(root, "apps"))) {
    if (existsSync(path.join(root, "apps", app, "README.md"))) files.push(`apps/${app}/README.md`);
  }
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir))) {
      const file = `${dir}/${entry}`;
      if (statSync(path.join(root, file)).isDirectory()) walk(file);
      else if (entry.endsWith(".md")) files.push(file);
    }
  };
  walk("docs");
  return files;
}

/** The text without fenced code blocks and inline code spans. */
function withoutCode(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
}

/** Link targets: inline `[text](target)` and reference definitions `[id]: target`. */
function linkTargets(text: string): string[] {
  const prose = withoutCode(text);
  const inline = [...prose.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g)].map(
    (match) => (match[1] ?? match[2])!,
  );
  const references = [...prose.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?$/gm)].map(
    (match) => match[1]!,
  );
  return [...inline, ...references];
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces as hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** The anchors a Markdown file's headings (and `<a id>`/`<a name>` tags) define. */
function anchors(text: string): Set<string> {
  const result = new Set<string>();
  const counts = new Map<string, number>();
  const prose = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
  for (const match of prose.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(match[1]!);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    result.add(seen === 0 ? base : `${base}-${seen}`);
  }
  for (const match of prose.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) result.add(match[1]!);
  return result;
}

/** The repository file a link target names, relative to the root, or undefined for an external link. */
function repoTarget(from: string, target: string): { file: string; anchor?: string } | undefined {
  let pathPart: string;
  if (target.startsWith(REPO_BLOB)) pathPart = target.slice(REPO_BLOB.length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return undefined;
  else pathPart = target;
  const hash = pathPart.indexOf("#");
  const anchor = hash === -1 ? undefined : decodeURIComponent(pathPart.slice(hash + 1));
  const filePart = decodeURIComponent(
    (hash === -1 ? pathPart : pathPart.slice(0, hash)).split("?")[0]!,
  );
  if (target.startsWith(REPO_BLOB)) return { file: path.normalize(filePart), anchor };
  if (filePart === "") return { file: from, anchor };
  const base = filePart.startsWith("/") ? "" : path.dirname(from);
  return { file: path.normalize(path.join(base, filePart.replace(/^\//, ""))), anchor };
}

describe("Markdown links", () => {
  const files = markdownFiles();

  it("finds the READMEs and the docs", () => {
    expect(files).toContain("README.md");
    expect(files).toContain("apps/agent/README.md");
    expect(files).toContain("docs/deploy-agent.md");
    expect(files.some((file) => file.startsWith("docs/adr/"))).toBe(true);
  });

  it("resolve to files and headings that exist", () => {
    const broken: string[] = [];
    let checked = 0;
    for (const from of files) {
      for (const target of linkTargets(readFileSync(path.join(root, from), "utf8"))) {
        const resolved = repoTarget(from, target);
        if (!resolved) continue;
        checked++;
        const absolute = path.join(root, resolved.file);
        if (!existsSync(absolute)) {
          broken.push(`${from}: ${target} (no ${resolved.file})`);
          continue;
        }
        if (resolved.anchor === undefined || !resolved.file.endsWith(".md")) continue;
        if (/^L\d+/.test(resolved.anchor)) continue;
        if (!anchors(readFileSync(absolute, "utf8")).has(resolved.anchor)) {
          broken.push(`${from}: ${target} (no heading #${resolved.anchor} in ${resolved.file})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(broken).toEqual([]);
  });
});

describe("the link checker", () => {
  it("reads inline links and reference definitions, not code", () => {
    const text = [
      'See [a](a.md#x) and [b](<b c.md> "title").',
      "`[not](code.md)`",
      "```",
      "[not](fenced.md)",
      "```",
      "[ref]: ref.md",
    ].join("\n");
    expect(linkTargets(text)).toEqual(["a.md#x", "b c.md", "ref.md"]);
  });

  it("makes GitHub's heading anchors", () => {
    expect(slug("Moving from @omniralph/harness")).toBe("moving-from-omniralphharness");
    expect(slug("1. Choose the agent's user")).toBe("1-choose-the-agents-user");
    expect(slug('Re-enrollment (`refresh_reuse`, "re-enrollment required")')).toBe(
      "re-enrollment-refresh_reuse-re-enrollment-required",
    );
    expect([...anchors("# A\n## A\n```\n# B\n```\n")]).toEqual(["a", "a-1"]);
  });
});
