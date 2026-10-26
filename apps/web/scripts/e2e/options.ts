import { parseArgs } from "node:util";

export interface E2eOptions {
  /** `--grep`: only tests whose title (file, describe and test names) matches this regex. */
  grep: string | null;
  /** `--grep-invert`: skip tests whose title matches this regex. */
  grepInvert: string | null;
  /** `--skip-build`: don't build the workspace packages first. */
  skipBuild: boolean;
  help: boolean;
}

export const USAGE = `Usage: pnpm --filter @omniralph/web e2e [options]

Runs the end-to-end specs (apps/web/e2e/*.spec.ts) with Playwright against
\`next dev\` on the fixture database.

Options:
  --grep <regex>         Only tests whose title (file, describe and test
                         names) matches, e.g. "smoke" or "enroll|agent"
  --grep-invert <regex>  Skip tests whose title matches
  --skip-build           Don't build the workspace packages the panel imports
  --help                 Show this help
`;

export function parseE2eOptions(argv: string[]): E2eOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      grep: { type: "string", short: "g" },
      "grep-invert": { type: "string" },
      "skip-build": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    grep: nonEmpty(values.grep, "--grep"),
    grepInvert: nonEmpty(values["grep-invert"], "--grep-invert"),
    skipBuild: values["skip-build"],
    help: values.help,
  };
}

/** The arguments `playwright test` takes for these options. */
export function playwrightArgs(options: E2eOptions): string[] {
  return [
    ...(options.grep === null ? [] : ["--grep", options.grep]),
    ...(options.grepInvert === null ? [] : ["--grep-invert", options.grepInvert]),
  ];
}

function nonEmpty(value: string | undefined, flag: string): string | null {
  if (value === undefined) return null;
  if (value.trim() === "") throw new Error(`${flag} needs a value`);
  try {
    new RegExp(value);
  } catch {
    throw new Error(`${flag}: invalid regular expression "${value}"`);
  }
  return value;
}
