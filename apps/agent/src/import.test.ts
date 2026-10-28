import { chmod, cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "./config.js";
import { silentLogger } from "./logger.js";
import { LocalSettingsStore } from "./settings.js";
import { parsePm2List, procCmdlines, type Pm2Runner, type ProcessLister } from "./import.js";
import { main, type MainDeps } from "./main.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "test/fixtures/import");
const AGENT_ID = "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10";
const REFRESH_TOKEN = "ort_fixture_refresh_token_do_not_print";
const NOW = Date.parse("2026-10-26T12:30:45.123Z");
// The old package's names, spelled out once.
const OLD_FILE = ["har", "ness.json"].join("");
const OLD_BINARY = ["omniralph-har", "ness"].join("");

const noPm2: Pm2Runner = async () => undefined;
const noProcesses: ProcessLister = async () => [];

function capture() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      stdout: (text: string) => void (out.stdout += text),
      stderr: (text: string) => void (out.stderr += text),
    },
  };
}

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    files.push(file);
    if (entry.isDirectory()) files.push(...(await walk(file)));
  }
  return files;
}

/** Every path under `dir` (but `skip`) with its content and mtime. */
async function snapshot(dir: string, skip: (file: string) => boolean = () => false) {
  const result: Record<string, { content: string | null; mtimeMs: number; mode: number }> = {};
  for (const file of await walk(dir)) {
    if (skip(file)) continue;
    const info = await stat(file);
    result[path.relative(dir, file)] = {
      content: info.isDirectory() ? null : await readFile(file, "utf8"),
      mtimeMs: info.mtimeMs,
      mode: info.mode,
    };
  }
  return result;
}

describe("omniralph-agent import", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "omniralph-import-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** Copies a fixture install to a temp home, as an install would have left it. */
  async function install(name: string, configMode = 0o600): Promise<string> {
    const home = path.join(tmp, name);
    await cp(path.join(FIXTURES, name), home, { recursive: true });
    for (const file of await walk(home)) {
      if (!file.endsWith(".json")) continue;
      const text = await readFile(file, "utf8");
      if (text.includes("{{home}}")) await writeFile(file, text.replaceAll("{{home}}", home));
    }
    const dir = path.join(home, ".config", "omniralph");
    for (const file of [OLD_FILE, "agent.json"]) {
      await chmod(path.join(dir, file), configMode).catch(() => undefined);
    }
    return home;
  }

  const oldConfig = (home: string) => path.join(home, ".config", "omniralph", OLD_FILE);
  const newConfig = (home: string) => path.join(home, ".config", "omniralph", "agent.json");
  const settingsFile = (dataDir: string) => path.join(dataDir, "settings.json");
  // The new config (and its backup), and the directory it shares with the old one; settings.json
  // in the data directory, and that directory.
  const isNewConfig =
    (home: string, dataDir = path.join(home, ".omniralph")) =>
    (file: string) =>
      file === newConfig(home) ||
      file.startsWith(`${newConfig(home)}.bak-`) ||
      file === path.dirname(newConfig(home)) ||
      file === settingsFile(dataDir) ||
      file === dataDir;

  async function run(args: string[], home: string, overrides: Partial<MainDeps> = {}) {
    const { out, io } = capture();
    const code = await main(["import", ...args], {
      io,
      env: {},
      homeDir: home,
      runPm2: noPm2,
      listProcesses: noProcesses,
      now: () => NOW,
      fetch: async () => {
        throw new Error("import must not make network calls");
      },
      ...overrides,
    });
    return { code, ...out, output: out.stdout + out.stderr };
  }

  it("imports a full install as the same agent and leaves the old install untouched", async () => {
    const home = await install("full");
    const before = await snapshot(home, isNewConfig(home));

    const result = await run([], home);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(newConfig(home), "utf8"))).toEqual({
      server: "https://omniralph.example",
      agentId: AGENT_ID,
      refreshToken: REFRESH_TOKEN,
      workspaceRoot: path.join(home, ".omniralph", "repos"),
      dataDir: path.join(home, ".omniralph"),
      blockedExecPaths: ["/opt/secret-tools"],
    });
    expect((await stat(newConfig(home))).mode & 0o777).toBe(0o600);
    // The machine settings it had go to settings.json in the data directory.
    const settings = settingsFile(path.join(home, ".omniralph"));
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({
      v: 1,
      acceptedTaskTypes: ["review", "coding"],
      installables: { allow: [] },
    });
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
    await expect(
      LocalSettingsStore.open({ file: settings, logger: silentLogger() }),
    ).resolves.toBeDefined();
    // What `start` reads.
    await expect(readConfig(newConfig(home))).resolves.toMatchObject({ agentId: AGENT_ID });

    expect(result.output).not.toContain(REFRESH_TOKEN);
    expect(result.stdout).toMatch(/refreshToken\s+imported \(hidden\)/);
    expect(result.stdout).toMatch(/server\s+imported \(https:\/\/omniralph\.example\)/);
    expect(result.stdout).toMatch(/installables\.allow\s+imported into settings\.json \(\[\]\)/);
    expect(result.stdout).toMatch(
      /acceptedTaskTypes\s+imported into settings\.json \(\["review","coding"\]\)/,
    );
    expect(result.stdout).toContain(`and ${settings}\n`);
    expect(result.stdout).toMatch(/update-state\.json\s+not imported: versions of @omniralph\/har/);
    expect(result.stdout).toMatch(/update-request\.json\s+not imported: versions of @omniralph/);
    for (const setting of ["slots", "pool limits", "host tool paths", "version pin"]) {
      expect(result.stdout).toMatch(
        new RegExp(`${setting}\\s+default \\(set them on the agent's page\\)`),
      );
    }
    for (const setting of ["pins", "desired version"]) {
      expect(result.stdout).toMatch(new RegExp(`${setting}\\s+kept by the control panel`));
    }
    expect(result.stdout).not.toContain("Warnings");
    expect(result.stdout).toContain(`Wrote ${newConfig(home)} and ${settings}.`);
    expect(result.stdout).toContain("omniralph-agent start");

    expect(await snapshot(home, isNewConfig(home))).toEqual(before);
    expect(
      (await readdir(path.dirname(newConfig(home)))).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("imports a minimal install, leaving the optional keys at their defaults", async () => {
    const home = await install("minimal");
    const result = await run([], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(newConfig(home), "utf8"))).toEqual({
      server: "https://omniralph.example",
      agentId: AGENT_ID,
      refreshToken: REFRESH_TOKEN,
      workspaceRoot: path.join(home, ".omniralph", "repos"),
    });
    for (const key of ["dataDir", "installables.allow", "blockedExecPaths", "acceptedTaskTypes"]) {
      expect(result.stdout).toMatch(new RegExp(`${key.replace(".", "\\.")}\\s+default\\n`));
    }
    // Nothing to put in settings.json: none is written.
    await expect(stat(settingsFile(path.join(home, ".omniralph")))).rejects.toThrow(/ENOENT/);
    expect(result.stdout).toContain(`Wrote ${newConfig(home)}. `);
    expect(result.stdout).not.toContain("update-state.json");
    expect(result.output).not.toContain(REFRESH_TOKEN);
  });

  it("imports a partial install and reports each gap", async () => {
    const home = await install("partial");
    const result = await run([], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(newConfig(home), "utf8"))).toEqual({
      server: "https://omniralph.example",
      agentId: AGENT_ID,
      refreshToken: REFRESH_TOKEN,
      workspaceRoot: path.join(home, "missing", "repos"),
      dataDir: path.join(home, "missing", "data"),
    });
    // Its data directory doesn't exist yet: settings.json creates it.
    expect(
      JSON.parse(await readFile(settingsFile(path.join(home, "missing", "data")), "utf8")),
    ).toEqual({ v: 1, installables: { allow: ["@omniralph/*", "@acme/*"] } });
    expect(result.stdout).toMatch(/blockedExecPaths\s+default/);
    expect(result.stdout).toMatch(/acceptedTaskTypes\s+default/);
    expect(result.stdout).toMatch(/maxConcurrency\s+not imported: unknown key/);
    expect(result.stdout).toMatch(/harnessName\s+not imported: unknown key/);
    expect(result.stdout).toMatch(/installables\.registry\s+not imported: unknown key/);
    expect(result.stdout).toContain(
      `workspaceRoot ${path.join(home, "missing", "repos")} doesn't exist: repos will be cloned again.`,
    );
    expect(result.stdout).toContain(
      `dataDir ${path.join(home, "missing", "data")} doesn't exist: installables will be reinstalled.`,
    );
    // Unknown keys are named, never their values.
    expect(result.output).not.toContain("builder-1");
    expect(result.output).not.toContain("npm.acme.example");
  });

  describe("without an old install", () => {
    it("exits 1, names the paths it checked and says to enroll", async () => {
      const home = path.join(tmp, "empty");
      const fromEnv = path.join(tmp, "elsewhere", OLD_FILE);
      const result = await run([], home, { env: { OMNIRALPH_HARNESS_CONFIG: fromEnv } });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(fromEnv);
      expect(result.stderr).toContain(oldConfig(home));
      expect(result.stderr).toContain("omniralph-agent enroll --server <url> --token <token>");
      await expect(stat(home)).rejects.toThrow();
    });

    it("checks only --from when it is given", async () => {
      const home = await install("minimal");
      const from = path.join(tmp, "nope.json");
      const result = await run(["--from", from], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`checked ${from})`);
      await expect(stat(newConfig(home))).rejects.toThrow();
    });
  });

  it("reads $OMNIRALPH_HARNESS_CONFIG before the default path, and --from before both", async () => {
    const full = await install("full");
    const minimal = await install("minimal");
    const target = path.join(tmp, "out", "agent.json");

    await run(["--config", target], minimal, {
      env: { OMNIRALPH_HARNESS_CONFIG: oldConfig(full) },
    });
    expect(JSON.parse(await readFile(target, "utf8")).dataDir).toBe(path.join(full, ".omniralph"));

    await rm(target);
    await run(["--from", oldConfig(minimal), "--config", target], full, {
      env: { OMNIRALPH_HARNESS_CONFIG: oldConfig(full) },
    });
    expect(JSON.parse(await readFile(target, "utf8")).dataDir).toBeUndefined();
  });

  it("writes to $OMNIRALPH_AGENT_CONFIG", async () => {
    const home = await install("minimal");
    const target = path.join(tmp, "env", "agent.json");
    const result = await run([], home, { env: { OMNIRALPH_AGENT_CONFIG: target } });
    expect(result.code).toBe(0);
    await expect(readConfig(target)).resolves.toMatchObject({ agentId: AGENT_ID });
    await expect(stat(newConfig(home))).rejects.toThrow();
  });

  describe("an unusable old config", () => {
    it("refuses invalid JSON", async () => {
      const home = await install("invalid-json");
      const result = await run([], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("it is not valid JSON");
      expect(result.stderr).toContain("Nothing was written");
      await expect(stat(newConfig(home))).rejects.toThrow();
    });

    it("refuses a config readable by group or others, with a chmod hint", async () => {
      const home = await install("bad-mode", 0o644);
      const result = await run([], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("readable by group or others (mode 644)");
      expect(result.stderr).toContain(`chmod 600 ${oldConfig(home)}`);
      expect(result.output).not.toContain(REFRESH_TOKEN);
      await expect(stat(newConfig(home))).rejects.toThrow();
    });

    it("names every missing required key", async () => {
      const home = await install("missing-keys", 0o640);
      const result = await run([], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("agentId is missing");
      expect(result.stderr).toContain("refreshToken is missing");
      expect(result.stderr).toContain("readable by group or others");
      expect(result.stderr).not.toContain("server is missing");
      expect(result.stderr).not.toContain("workspaceRoot is missing");
      await expect(stat(newConfig(home))).rejects.toThrow();
    });

    it("refuses a server URL and optional keys the agent wouldn't accept", async () => {
      const home = path.join(tmp, "bad-values");
      const from = path.join(home, "old.json");
      await cp(path.join(FIXTURES, "minimal"), home, { recursive: true });
      await writeFile(
        from,
        JSON.stringify({
          server: "http://omniralph.example",
          agentId: AGENT_ID,
          refreshToken: REFRESH_TOKEN,
          workspaceRoot: "/srv/repos",
          dataDir: "relative/data",
        }),
        { mode: 0o600 },
      );
      const result = await run(["--from", from], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("server: server URL must use https://");
      expect(result.output).not.toContain(REFRESH_TOKEN);
      await expect(stat(newConfig(home))).rejects.toThrow();

      const json = JSON.parse(await readFile(from, "utf8"));
      await writeFile(from, JSON.stringify({ ...json, server: "https://omniralph.example" }));
      const second = await run(["--from", from], home);
      expect(second.code).toBe(1);
      expect(second.stderr).toContain("dataDir: must be an absolute path");
    });
  });

  describe("an existing new config", () => {
    it("exits 1 and changes nothing without --force", async () => {
      const home = await install("existing-config");
      const before = await snapshot(home);
      const result = await run([], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${newConfig(home)} already exists`);
      expect(result.stderr).toContain("--force");
      expect(await snapshot(home)).toEqual(before);
    });

    it("backs it up (mode 0600) and replaces it with --force", async () => {
      const home = await install("existing-config");
      const stale = await readFile(newConfig(home), "utf8");
      await chmod(newConfig(home), 0o644);
      const before = await snapshot(home, isNewConfig(home));

      const result = await run(["--force"], home);

      expect(result.code).toBe(0);
      const backup = `${newConfig(home)}.bak-20261026T123045Z`;
      expect(result.stdout).toContain(`Backed up the existing config to ${backup}`);
      expect(await readFile(backup, "utf8")).toBe(stale);
      expect((await stat(backup)).mode & 0o777).toBe(0o600);
      await expect(readConfig(newConfig(home))).resolves.toMatchObject({
        agentId: AGENT_ID,
        refreshToken: REFRESH_TOKEN,
      });
      expect(await snapshot(home, isNewConfig(home))).toEqual(before);
    });
  });

  describe("the old daemon", () => {
    async function pm2Fixture(home: string, status?: string): Promise<Pm2Runner> {
      let text = await readFile(path.join(home, "pm2-jlist.json"), "utf8");
      if (status) text = text.replaceAll('"status": "online"', `"status": "${status}"`);
      return async (args) => {
        expect(args).toEqual(["jlist"]);
        return `>>>> In-memory PM2 is out-of-date\n${text}`;
      };
    }

    it("refuses while pm2 runs it, and says how to stop it", async () => {
      const home = await install("pm2-running");
      const result = await run([], home, { runPm2: await pm2Fixture(home) });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`pm2 process '${OLD_BINARY}'`);
      expect(result.stderr).toContain("share one refresh token, and reusing it revokes the agent");
      expect(result.stderr).toContain(`'pm2 stop ${OLD_BINARY}'`);
      expect(result.output).not.toContain("pm2-env-secret");
      expect(result.output).not.toContain(REFRESH_TOKEN);
      await expect(stat(newConfig(home))).rejects.toThrow();
    });

    it("imports with --force and prints the commands that replace the pm2 process", async () => {
      const home = await install("pm2-running");
      const result = await run(["--force"], home, { runPm2: await pm2Fixture(home) });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        [
          `  1. pm2 delete ${OLD_BINARY}`,
          `  2. pm2 start "$(command -v omniralph-agent)" --name omniralph-agent --kill-timeout 90000 --max-restarts 5 -- start --healthz-port 9310`,
          "  3. pm2 save",
        ].join("\n"),
      );
      expect(result.output).not.toContain("pm2-env-secret");
    });

    it("prints the replacement commands for a stopped pm2 process", async () => {
      const home = await install("pm2-running");
      const target = path.join(tmp, "custom", "agent.json");
      const result = await run(["--config", target], home, {
        runPm2: await pm2Fixture(home, "stopped"),
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`pm2 delete ${OLD_BINARY}`);
      expect(result.stdout).toContain(`-- start --healthz-port 9310 --config ${target}`);
      expect(result.stdout).toContain("pm2 save");
    });

    it("refuses while a non-pm2 process runs it", async () => {
      const home = await install("process-running");
      const result = await run([], home, {
        listProcesses: procCmdlines(path.join(home, "proc"), -1),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`/usr/local/bin/${OLD_BINARY} start --healthz-port 9310`);
      expect(result.stderr).toContain(`systemctl stop ${OLD_BINARY}`);
      expect(result.stderr).not.toContain("less ");
      await expect(stat(newConfig(home))).rejects.toThrow();

      const forced = await run(["--force"], home, {
        listProcesses: procCmdlines(path.join(home, "proc"), -1),
      });
      expect(forced.code).toBe(0);
    });

    it("reads only the name, status, exec path and args of pm2 processes", async () => {
      const text = await readFile(path.join(FIXTURES, "pm2-running", "pm2-jlist.json"), "utf8");
      expect(parsePm2List(text)).toEqual([
        {
          name: "web",
          status: "online",
          execPath: "/usr/lib/node_modules/serve/bin/serve.js",
          args: ["-l", "3000"],
        },
        {
          name: OLD_BINARY,
          status: "online",
          execPath: `/usr/local/bin/${OLD_BINARY}`,
          args: ["start", "--healthz-port", "9310"],
        },
      ]);
      expect(parsePm2List("")).toEqual([]);
    });
  });

  describe("settings.json", () => {
    const settingsOf = (home: string) => settingsFile(path.join(home, ".omniralph"));

    it("merges the imported keys into a settings.json already there", async () => {
      const home = await install("full");
      await writeFile(
        settingsOf(home),
        JSON.stringify({ v: 1, maxConcurrency: 3, installables: { allow: ["@acme/*"] } }),
        { mode: 0o600 },
      );
      const result = await run([], home);
      expect(result.code).toBe(0);
      expect(JSON.parse(await readFile(settingsOf(home), "utf8"))).toEqual({
        v: 1,
        maxConcurrency: 3,
        installables: { allow: [] },
        acceptedTaskTypes: ["review", "coding"],
      });
    });

    it("refuses, writing nothing, when the settings.json there isn't valid", async () => {
      const home = await install("full");
      await writeFile(settingsOf(home), `{"v":1,"maxConcurrency":99}`, { mode: 0o600 });
      const result = await run([], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${settingsOf(home)} exists and isn't valid`);
      expect(result.stderr).toContain("Nothing was written.");
      await expect(stat(newConfig(home))).rejects.toThrow(/ENOENT/);
      expect(await readFile(settingsOf(home), "utf8")).toBe(`{"v":1,"maxConcurrency":99}`);
    });

    it("refuses accepted task types or an allow-list settings.json wouldn't accept", async () => {
      const home = path.join(tmp, "bad-settings");
      const from = path.join(home, "old.json");
      await cp(path.join(FIXTURES, "minimal"), home, { recursive: true });
      await writeFile(
        from,
        JSON.stringify({
          server: "https://omniralph.example",
          agentId: AGENT_ID,
          refreshToken: REFRESH_TOKEN,
          workspaceRoot: "/srv/repos",
          acceptedTaskTypes: [],
          installables: { allow: ["@a/b/c"] },
        }),
        { mode: 0o600 },
      );
      const result = await run(["--from", from], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/acceptedTaskTypes: /);
      expect(result.stderr).toMatch(/installables\.allow\.0: must be an npm package name/);
      await expect(stat(newConfig(home))).rejects.toThrow(/ENOENT/);
      await expect(stat(settingsOf(home))).rejects.toThrow(/ENOENT/);
    });

    it("writes no settings.json on a dry run", async () => {
      const home = await install("full");
      const result = await run(["--dry-run"], home);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`and ${settingsOf(home)}\n`);
      await expect(stat(settingsOf(home))).rejects.toThrow(/ENOENT/);
    });
  });

  describe("--dry-run", () => {
    it("prints the same summary and writes nothing, even over an existing config", async () => {
      const home = await install("dry-run");
      const before = await snapshot(home);
      const dry = await run(["--dry-run"], home);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain("Dry run: nothing was written.");
      expect(dry.stdout).toContain(
        `${newConfig(home)} exists: an import would refuse without --force.`,
      );
      expect(dry.output).not.toContain(REFRESH_TOKEN);
      expect(await snapshot(home)).toEqual(before);

      const real = await run(["--force"], home);
      expect(real.code).toBe(0);
      const summary = (stdout: string) =>
        stdout.slice(0, stdout.indexOf("\n\n", stdout.indexOf("\n\n") + 2));
      expect(summary(dry.stdout)).toBe(summary(real.stdout));
    });

    it("writes nothing for a fresh install either, and notes a running daemon", async () => {
      const home = await install("pm2-running");
      const before = await snapshot(home);
      const runPm2: Pm2Runner = async () => readFile(path.join(home, "pm2-jlist.json"), "utf8");
      const result = await run(["--dry-run"], home, { runPm2 });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("An import would refuse: the old daemon is running");
      expect(result.stdout).toContain(`pm2 delete ${OLD_BINARY}`);
      expect(await snapshot(home)).toEqual(before);
    });

    it("still exits 1 for an unusable old config", async () => {
      const home = await install("invalid-json");
      expect((await run(["--dry-run"], home)).code).toBe(1);
    });
  });

  describe("start without a config", () => {
    it("points to import when the old config is at its default path", async () => {
      const home = await install("minimal");
      const { out, io } = capture();
      expect(await main(["start"], { io, env: {}, homeDir: home })).toBe(1);
      expect(out.stderr).toContain(`${newConfig(home)} not found`);
      expect(out.stderr).toContain("run 'omniralph-agent import'");
    });

    it("points to enroll otherwise", async () => {
      const { out, io } = capture();
      expect(await main(["start"], { io, env: {}, homeDir: tmp })).toBe(1);
      expect(out.stderr).toContain("run 'omniralph-agent enroll --server <url> --token <token>'");
      expect(out.stderr).not.toContain("omniralph-agent import");
    });
  });
});
