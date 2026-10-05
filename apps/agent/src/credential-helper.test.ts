import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FetchFn } from "./api.js";
import { parseCredentialRequest } from "./credential-helper.js";
import { jobProcessEnv } from "./job-env.js";
import { main } from "./main.js";
import { credentialConfigArgs, defaultCredentialHelper } from "./workspace/git.js";

// Always in the future: git (≥ 2.41) ignores passwords whose password_expiry_utc has passed.
const EXPIRES_AT = new Date(Math.floor(Date.now() / 1000 + 3600) * 1000).toISOString();
const CREDENTIAL = {
  cloneUrl: "https://github.com/acme/app.git",
  username: "x-access-token",
  password: "ghs_installation_token",
  expiresAt: EXPIRES_AT,
};

function fakeFetch(status = 200, body: unknown = CREDENTIAL) {
  return vi.fn<FetchFn>(async () => Response.json(body, { status }));
}

async function helper(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: string; fetch?: ReturnType<typeof fakeFetch> } = {},
) {
  const out = { stdout: "", stderr: "" };
  const fetch = options.fetch ?? fakeFetch();
  const code = await main(["git-credential", ...args], {
    env: options.env ?? {
      OMNIRALPH_JOB_TOKEN: "job-token",
      OMNIRALPH_JOB_ID: "job-1",
      OMNIRALPH_SERVER: "https://omniralph.example",
    },
    fetch,
    readStdin: async () =>
      options.stdin ?? "protocol=https\nhost=github.com\npath=acme/app.git\n\n",
    io: { stdout: (t) => (out.stdout += t), stderr: (t) => (out.stderr += t) },
  });
  return { code, ...out, fetch };
}

describe("git-credential", () => {
  it("answers `get` with the brokered credential in git's key=value format", async () => {
    const { code, stdout, fetch } = await helper(["get"]);
    expect(code).toBe(0);
    expect(stdout).toBe(
      `username=x-access-token\npassword=ghs_installation_token\npassword_expiry_utc=${Date.parse(EXPIRES_AT) / 1000}\n`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://omniralph.example/api/agent/credentials");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer job-token");
    expect(init?.redirect).toBe("error");
  });

  it("ignores store and erase", async () => {
    for (const op of ["store", "erase"]) {
      const { code, stdout, fetch } = await helper([op]);
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("gives no credential to other hosts or protocols", async () => {
    for (const stdin of [
      "protocol=https\nhost=evil.example\n\n",
      "protocol=http\nhost=github.com\n\n",
    ]) {
      const { code, stdout } = await helper(["get"], { stdin });
      expect(code).toBe(0);
      expect(stdout).toBe("");
    }
  });

  it("needs the job token and never falls back to other tokens", async () => {
    const { code, stdout, stderr, fetch } = await helper(["get"], {
      env: { OMNIRALPH_SERVER: "https://omniralph.example", OMNIRALPH_ACCESS_TOKEN: "agent" },
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("OMNIRALPH_JOB_TOKEN");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("outputs nothing when the control panel refuses (e.g. the job isn't running)", async () => {
    const { code, stdout, stderr } = await helper(["get"], {
      fetch: fakeFetch(401, { error: "unauthorized" }),
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("401");
  });

  it("refuses values that would inject extra attributes", async () => {
    const { code, stdout } = await helper(["get"], {
      fetch: fakeFetch(200, { ...CREDENTIAL, password: "token\nusername=evil" }),
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
  });

  it("refuses a non-https server", async () => {
    const { code, fetch } = await helper(["get"], {
      env: { OMNIRALPH_JOB_TOKEN: "t", OMNIRALPH_SERVER: "http://omniralph.example" },
    });
    expect(code).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("parses git's request up to the blank line", () => {
    expect(
      Object.fromEntries(
        parseCredentialRequest("protocol=https\r\nhost=a.example:8443\n\nhost=ignored\n"),
      ),
    ).toEqual({ protocol: "https", host: "a.example:8443" });
  });
});

describe("git with the agent's credential helper", () => {
  let dir: string;
  let server: Server;
  let serverUrl: string;
  const requests: { authorization: string | undefined; url: string | undefined }[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-git-credential-"));
    server = createServer((req, res) => {
      requests.push({ authorization: req.headers.authorization, url: req.url });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...CREDENTIAL, cloneUrl: "https://git.example.com/acme/app.git" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("uses only the agent's helper: host-level helpers (global and URL-specific) never run", async () => {
    const marker = path.join(dir, "host-helper-ran");
    const globalConfig = path.join(dir, "gitconfig");
    await writeFile(
      globalConfig,
      [
        "[credential]",
        `\thelper = "!f() { touch ${marker}; echo username=host; echo password=host-secret; }; f"`,
        '[credential "https://git.example.com"]',
        `\thelper = "!f() { touch ${marker}; echo password=host-url-secret; }; f"`,
      ].join("\n"),
    );
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const tsx = import.meta.resolve("tsx");
    const credentialHelper = defaultCredentialHelper(
      process.execPath,
      ["--import", tsx, "--conditions=@omniralph/source"],
      cli,
    );
    const env = jobProcessEnv(
      { jobId: "job-1", jobToken: "the-job-token", server: serverUrl },
      {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        OMNIRALPH_AGENT_CONFIG: "x",
      },
    );

    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "git",
        [...credentialConfigArgs(credentialHelper), "credential", "fill"],
        { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, cwd: dir, timeout: 30_000 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
      );
      child.stdin!.end("protocol=https\nhost=git.example.com\npath=acme/app.git\n\n");
    });

    expect(output).toContain("username=x-access-token\n");
    expect(output).toContain("password=ghs_installation_token\n");
    expect(output).not.toContain("host-secret");
    expect(output).not.toContain("host-url-secret");
    await expect(stat(marker)).rejects.toThrow();
    expect(requests).toEqual([
      { authorization: "Bearer the-job-token", url: "/api/agent/credentials" },
    ]);
  }, 40_000);
});
