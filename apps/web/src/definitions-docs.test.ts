import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/definitions.md (and the ADR section that links it) may only name pages, files and
// functions that exist.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const DOCS = ["docs/definitions.md", "docs/adr/0008-agents-tasks-and-the-harness.md"];

/** Every non-test TypeScript source of the web app and the packages, concatenated. */
function sourceText(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
      const file = path.join(dir, entry);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        parts.push(readFileSync(file, "utf8"));
      }
    }
  };
  walk(path.join(root, "apps/web/src"));
  for (const pkg of readdirSync(path.join(root, "packages"))) {
    const src = path.join(root, "packages", pkg, "src");
    if (existsSync(src)) walk(src);
  }
  return parts.join("\n");
}

/** Inline code spans of a Markdown text. */
function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
}

/** The app directory serving a control-panel path (`/repositories/<id>/settings`). */
function pageDir(route: string): string {
  const segments = route
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith("<") ? "[id]" : segment));
  return path.join(root, "apps/web/src/app/(app)", ...segments);
}

describe("docs/definitions.md", () => {
  const doc = read("docs/definitions.md");
  const spans = codeSpans(doc);

  it("names the pages, validators and referrer lookup the story asks for", () => {
    for (const name of [
      "/settings/agents",
      "/settings/tasks",
      "validateAgentDefinition",
      "validateTaskDefinition",
      "findTaskReferrers",
    ]) {
      expect(spans).toContain(name);
    }
  });

  it("only names control-panel pages that exist", () => {
    const routes = spans.filter((span) => /^\/(settings|repositories)\b/.test(span));
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(existsSync(path.join(pageDir(route), "page.tsx")), route).toBe(true);
    }
  });

  it("only names files that exist", () => {
    for (const docPath of DOCS) {
      const files = codeSpans(read(docPath)).filter((span) =>
        /^(apps|packages)\/[\w./()[\]-]+\.tsx?$/.test(span),
      );
      for (const file of files) expect(existsSync(path.join(root, file)), file).toBe(true);
    }
  });

  it("only names functions and fields that are in the code", () => {
    const source = sourceText();
    const identifiers = spans.filter((span) => /^[a-z]+[A-Z][A-Za-z]*$/.test(span));
    expect(identifiers.length).toBeGreaterThan(5);
    for (const identifier of identifiers) {
      expect(source.includes(identifier), identifier).toBe(true);
    }
    // What the forms' `/api/ui` handlers call.
    for (const action of [
      "createAgent",
      "updateAgent",
      "cloneAgent",
      "deleteAgent",
      "createTask",
      "updateTask",
      "cloneTask",
      "deleteTask",
    ]) {
      expect(source).toContain(`export async function ${action}(`);
    }
  });

  it("is linked from ADR 0008 and docs/chat.md", () => {
    expect(read("docs/adr/0008-agents-tasks-and-the-harness.md")).toContain("](../definitions.md)");
    expect(read("docs/chat.md")).toContain("](definitions.md)");
  });
});
