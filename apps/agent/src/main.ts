import { parseArgs } from "node:util";
import { CAPABILITIES } from "@omniralph/shared";

export const USAGE = `Usage: omniralph-agent <command> [options]

Commands:
  enroll          Enroll this host with the control panel (not yet implemented)
  run             Start the agent daemon (not yet implemented)
  git-credential  Git credential helper (not yet implemented)

Options:
  -h, --help      Show this help
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** Parses the CLI arguments and returns the process exit code. */
export function main(argv: string[], io: Io = defaultIo): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: false,
  });

  const [command] = positionals;
  if (values.help || command === undefined) {
    io.stdout(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  switch (command) {
    case "enroll":
    case "run":
    case "git-credential":
      io.stderr(
        `omniralph-agent: '${command}' is not implemented yet (capabilities: ${CAPABILITIES.join(", ")})\n`,
      );
      return 1;
    default:
      io.stderr(`omniralph-agent: unknown command '${command}'\n\n${USAGE}`);
      return 1;
  }
}
