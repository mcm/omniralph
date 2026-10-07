import { execFile, spawn } from "node:child_process";
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
import { credentialConfigArgs, defaultCredentialHelper, gitEnv } from "./workspace/git.js";

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

  it("reads the job token from OMNIRALPH_JOB_TOKEN_FILE (a long session's current token)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "omniralph-helper-"));
    try {
      const file = path.join(dir, "token");
      await writeFile(file, "fresh-token\n");
      const { code, stdout, fetch } = await helper(["get"], {
        env: { OMNIRALPH_JOB_TOKEN_FILE: file, OMNIRALPH_SERVER: "https://omniralph.example" },
      });
      expect(code).toBe(0);
      expect(stdout).toContain("password=ghs_installation_token\n");
      expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(
        "Bearer fresh-token",
      );

      const missing = await helper(["get"], {
        env: {
          OMNIRALPH_JOB_TOKEN_FILE: path.join(dir, "gone"),
          OMNIRALPH_SERVER: "https://omniralph.example",
        },
      });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("OMNIRALPH_JOB_TOKEN_FILE");
      expect(missing.fetch).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("outputs nothing when the control panel refuses (e.g. the job isn't running)", async () => {
    const { code, stdout, stderr } = await helper(["get"], {
      fetch: fakeFetch(401, { error: "unauthorized" }),
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("401");
  });

  it("prints the control panel's explanation when the code host refuses the access", async () => {
    const message =
      "The GitHub App installation 7 on acme/app isn't granted Contents: Read and write.";
    const { code, stdout, stderr } = await helper(["get"], {
      fetch: fakeFetch(403, { error: "scm_permission_missing", message }),
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(`403 (scm_permission_missing): ${message}`);
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

describe("pushing from a ralph job's worktree with the brokered credential", () => {
  const WRITE_TOKEN = "ghs_contents_write";
  let dir: string;
  let origin: string;
  let gitServer: Server;
  let gitUrl: string;
  let broker: Server;
  let brokerUrl: string;
  const brokerRequests: (string | undefined)[] = [];
  const gitAuth: (string | undefined)[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-git-push-"));
    origin = path.join(dir, "origin.git");
    await git(["init", "--bare", "--initial-branch=main", origin], dir);

    // A smart-HTTP git server (`git http-backend`) that only accepts the
    // brokered write token, standing in for the code host.
    gitServer = createServer((req, res) => {
      const authorization = req.headers.authorization;
      gitAuth.push(authorization);
      const expected = `Basic ${Buffer.from(`x-access-token:${WRITE_TOKEN}`).toString("base64")}`;
      if (authorization !== expected) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://git");
      const child = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: dir,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: "x-access-token",
          REQUEST_METHOD: req.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          ...(req.headers["content-encoding"] && {
            HTTP_CONTENT_ENCODING: req.headers["content-encoding"],
          }),
        },
      });
      req.pipe(child.stdin);
      let head = Buffer.alloc(0);
      let headersSent = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (headersSent) return void res.write(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        let status = 200;
        for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
          else res.setHeader(name, value);
        }
        res.writeHead(status);
        headersSent = true;
        res.write(head.subarray(end + 4));
      });
      child.on("close", () => res.end());
    });
    await new Promise<void>((resolve) => gitServer.listen(0, "127.0.0.1", resolve));
    gitUrl = `http://127.0.0.1:${(gitServer.address() as AddressInfo).port}/origin.git`;

    // The control panel's credential broker, as it answers a ralph job's token.
    broker = createServer((req, res) => {
      brokerRequests.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...CREDENTIAL, cloneUrl: gitUrl, password: WRITE_TOKEN }));
    });
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
    brokerUrl = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    gitServer.close();
    broker.close();
    await rm(dir, { recursive: true, force: true });
  });

  function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    return new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd, env: gitEnv(env), timeout: 30_000 }, (error, stdout, stderr) =>
        error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
      );
    });
  }

  it("pushes a commit to the remote branch using the write credential", async () => {
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const tsx = import.meta.resolve("tsx");
    const credentialHelper = defaultCredentialHelper(
      process.execPath,
      ["--import", tsx, "--conditions=@omniralph/source"],
      cli,
    );
    const env = {
      ...jobProcessEnv(
        { jobId: "ralph-job-1", jobToken: "ralph-job-token", server: brokerUrl },
        { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      ),
      GIT_AUTHOR_NAME: "Omniralph",
      GIT_AUTHOR_EMAIL: "omniralph@example.com",
      GIT_COMMITTER_NAME: "Omniralph",
      GIT_COMMITTER_EMAIL: "omniralph@example.com",
    };
    const creds = credentialConfigArgs(credentialHelper);

    // Seed the origin through a plain local clone (no credentials involved).
    const seed = path.join(dir, "seed");
    await git(["clone", origin, seed], dir, env);
    await writeFile(path.join(seed, "README.md"), "hello\n");
    await git(["add", "README.md"], seed, env);
    await git(["commit", "-m", "init"], seed, env);
    await git(["push", "origin", "HEAD:main"], seed, env);

    // The job's clone and its branch worktree, talking to the HTTP remote.
    const clone = path.join(dir, "clone");
    await git([...creds, "clone", gitUrl, clone], dir, env);
    const worktree = path.join(dir, "worktree");
    await git(["worktree", "add", "-b", "feature/epic", worktree, "origin/main"], clone, env);
    await writeFile(path.join(worktree, "story.txt"), "story\n");
    await git(["add", "story.txt"], worktree, env);
    await git(["commit", "-m", "feat(TOOL-1): Story"], worktree, env);
    const head = (await git(["rev-parse", "HEAD"], worktree, env)).trim();

    gitAuth.length = 0;
    await git([...creds, "push", "origin", "HEAD:refs/heads/feature/epic"], worktree, env);

    expect((await git(["rev-parse", "refs/heads/feature/epic"], origin)).trim()).toBe(head);
    expect(brokerRequests.length).toBeGreaterThan(0);
    expect(brokerRequests.every((auth) => auth === "Bearer ralph-job-token")).toBe(true);
    // The push was refused without credentials, then made with the brokered token.
    expect(gitAuth[0]).toBeUndefined();
    expect(gitAuth.at(-1)).toBe(
      `Basic ${Buffer.from(`x-access-token:${WRITE_TOKEN}`).toString("base64")}`,
    );

    // Without the helper, the push is refused.
    await expect(
      git(["-c", "credential.helper=", "push", "origin", "HEAD:refs/heads/other"], worktree, env),
    ).rejects.toThrow();
  }, 60_000);
});
