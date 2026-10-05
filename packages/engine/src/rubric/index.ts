import { readFileSync } from "node:fs";
import { extname } from "node:path";

/**
 * Review rubric, adapted from claude-skills' `code-reviewer` skill (MIT, see
 * THIRD_PARTY_NOTICES.md): `universal.md` is always included, plus one
 * `languages/<id>.md` per language present in the reviewed files. CI
 * workflow files (`ci`) get their own rubric, matched by path rather than by
 * extension because `.yml` is not otherwise reviewed as a language.
 */

export const RUBRIC_LANGUAGES = [
  "typescript",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "csharp",
  "ruby",
  "php",
  "swift",
  "dart",
  "c",
  "cpp",
  "ci",
] as const;

export type RubricLanguage = (typeof RUBRIC_LANGUAGES)[number];

/** Extension (lower-case, with the dot) → rubric language. */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, RubricLanguage>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".csx": "csharp",
  ".razor": "csharp",
  ".cshtml": "csharp",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".php": "php",
  ".phtml": "php",
  ".swift": "swift",
  ".dart": "dart",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
};

const LANGUAGE_BY_FILENAME: Readonly<Record<string, RubricLanguage>> = {
  Rakefile: "ruby",
  Gemfile: "ruby",
};

/** GitHub Actions workflows (only `.github/workflows/` at the repo root is read) and GitLab CI. */
export function isCiWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || /(^|\/)\.gitlab-ci\.ya?ml$/.test(path);
}

export function languageForPath(path: string): RubricLanguage | undefined {
  if (isCiWorkflowPath(path)) return "ci";
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LANGUAGE_BY_FILENAME[name] ?? LANGUAGE_BY_EXTENSION[extname(name).toLowerCase()];
}

/** Languages present in `paths`, in `RUBRIC_LANGUAGES` order (stable for prompt caching). */
export function languagesForPaths(paths: Iterable<string>): RubricLanguage[] {
  const present = new Set<RubricLanguage>();
  for (const path of paths) {
    const language = languageForPath(path);
    if (language) present.add(language);
  }
  return RUBRIC_LANGUAGES.filter((language) => present.has(language));
}

const cache = new Map<string, string>();

/** Rubric files ship next to the module (`build` copies them into `dist/rubric`). */
function readRubricFile(relativePath: string): string {
  let text = cache.get(relativePath);
  if (text === undefined) {
    text = readFileSync(new URL(relativePath, import.meta.url), "utf8").trim();
    cache.set(relativePath, text);
  }
  return text;
}

export function universalRubric(): string {
  return readRubricFile("./universal.md");
}

export function languageRubric(language: RubricLanguage): string {
  return readRubricFile(`./languages/${language}.md`);
}

/** `universal.md` followed by each language's rules. */
export function renderRubric(languages: readonly RubricLanguage[]): string {
  return [universalRubric(), ...languages.map(languageRubric)].join("\n\n");
}
