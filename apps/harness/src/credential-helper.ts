import { readFile } from "node:fs/promises";
import { CloneCredentialResponse } from "@omniralph/shared";
import { ApiError, postJson, type FetchFn } from "./api.js";
import { validateServerUrl } from "./config.js";
import { JOB_TOKEN_ENV, JOB_TOKEN_FILE_ENV, SERVER_ENV } from "./job-env.js";

export interface GitCredentialIo {
  /** Reads the request git writes to the helper's stdin. */
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Parses git's `key=value` credential description (up to the first blank line). */
export function parseCredentialRequest(input: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const line of input.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "") break;
    const eq = trimmed.indexOf("=");
    if (eq > 0) attributes.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return attributes;
}

/** Reads stdin until git's terminating blank line or EOF. */
export async function readCredentialRequest(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (/(^|\n)\r?\n/.test(text)) break;
  }
  return text;
}

function safeValue(value: string): boolean {
  return !/[\n\r\0]/.test(value);
}

/**
 * `omniralph-harness git-credential <operation>`: a git credential helper
 * (https://git-scm.com/docs/gitcredentials). Only `get` does anything: it
 * fetches a short-lived, read-only credential for the job's repository from
 * `POST /api/agent/credentials`, authenticated with the job token in
 * `OMNIRALPH_JOB_TOKEN`, or read from the file `OMNIRALPH_JOB_TOKEN_FILE`
 * names (which the agent keeps current), never the agent's own tokens. `store` and `erase`
 * are ignored. Hosts other than the job repository's get no credential.
 */
export async function runGitCredential(
  operation: string | undefined,
  env: NodeJS.ProcessEnv,
  io: GitCredentialIo,
  fetchFn: FetchFn,
): Promise<number> {
  const input = await io.readStdin();
  if (operation !== "get") return 0;

  const tokenFile = env[JOB_TOKEN_FILE_ENV];
  let jobToken = env[JOB_TOKEN_ENV];
  if (tokenFile) {
    try {
      jobToken = (await readFile(tokenFile, "utf8")).trim();
    } catch (error) {
      io.stderr(
        `omniralph-harness git-credential: can't read ${JOB_TOKEN_FILE_ENV}: ${String(error)}\n`,
      );
      return 1;
    }
  }
  const serverEnv = env[SERVER_ENV];
  if (!jobToken || !serverEnv) {
    io.stderr(
      `omniralph-harness git-credential: ${JOB_TOKEN_ENV} (or ${JOB_TOKEN_FILE_ENV}) and ${SERVER_ENV} must be set (only jobs get credentials)\n`,
    );
    return 1;
  }
  let server: string;
  try {
    server = validateServerUrl(serverEnv);
  } catch (error) {
    io.stderr(`omniralph-harness git-credential: ${(error as Error).message}\n`);
    return 1;
  }

  let credential: CloneCredentialResponse;
  try {
    credential = await postJson(
      fetchFn,
      `${server}/api/agent/credentials`,
      {},
      CloneCredentialResponse,
      jobToken,
    );
  } catch (error) {
    const message = error instanceof ApiError ? error.message : String(error);
    io.stderr(`omniralph-harness git-credential: ${message}\n`);
    return 1;
  }

  const request = parseCredentialRequest(input);
  const target = new URL(credential.cloneUrl);
  const protocol = request.get("protocol");
  const host = request.get("host");
  if (
    (protocol && protocol !== target.protocol.replace(/:$/, "")) ||
    (host && host !== target.host)
  ) {
    // E.g. a submodule on another host: never hand it the job repository's token.
    io.stderr(
      `omniralph-harness git-credential: no credential for ${protocol ?? "?"}://${host ?? "?"}\n`,
    );
    return 0;
  }
  if (!safeValue(credential.username) || !safeValue(credential.password)) {
    io.stderr("omniralph-harness git-credential: the control panel returned an invalid credential\n");
    return 1;
  }
  const expiry = Math.floor(new Date(credential.expiresAt).getTime() / 1000);
  io.stdout(
    `username=${credential.username}\npassword=${credential.password}\npassword_expiry_utc=${expiry}\n`,
  );
  return 0;
}
