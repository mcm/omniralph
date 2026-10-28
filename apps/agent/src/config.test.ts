import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dataDir,
  defaultConfigPath,
  defaultDataDir,
  defaultWorkspaceRoot,
  execPathBlocked,
  readConfig,
  validateServerUrl,
  writeConfig,
  type AgentConfig,
} from "./config.js";

const CONFIG: AgentConfig = {
  server: "https://omniralph.example",
  agentId: "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10",
  refreshToken: "secret-refresh-token",
  workspaceRoot: "/home/agent/.omniralph/repos",
};

describe("validateServerUrl", () => {
  it("accepts https and normalises the trailing slash", () => {
    expect(validateServerUrl("https://omniralph.example/")).toBe("https://omniralph.example");
    expect(validateServerUrl("https://omniralph.example/base/")).toBe(
      "https://omniralph.example/base",
    );
  });

  it("allows http only for localhost and 127.0.0.1", () => {
    expect(validateServerUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(validateServerUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(() => validateServerUrl("http://omniralph.example")).toThrow(/https/);
    expect(() => validateServerUrl("http://localhost.evil.example")).toThrow(/https/);
    expect(() => validateServerUrl("http://10.0.0.1")).toThrow(/https/);
    expect(() => validateServerUrl("ftp://localhost")).toThrow(/https/);
  });

  it("rejects garbage, credentials and queries", () => {
    expect(() => validateServerUrl("omniralph.example")).toThrow(/invalid server URL/);
    expect(() => validateServerUrl("https://user:pw@omniralph.example")).toThrow(/credentials/);
    expect(() => validateServerUrl("https://omniralph.example/?x=1")).toThrow(/query/);
  });
});

describe("config file", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-config-"));
    file = path.join(dir, "nested", "agent.json");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes mode 0600 in a 0700 directory and reads it back", async () => {
    await writeConfig(file, CONFIG);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readConfig(file)).toEqual(CONFIG);
  });

  it("replaces the file by rename and leaves no temp files", async () => {
    await writeConfig(file, CONFIG);
    const before = (await stat(file)).ino;
    await writeConfig(file, { ...CONFIG, refreshToken: "next" });
    expect((await stat(file)).ino).not.toBe(before);
    expect((await readConfig(file)).refreshToken).toBe("next");
    expect(await readdir(path.dirname(file))).toEqual(["agent.json"]);
  });

  it("keeps the old file intact when writing fails", async () => {
    await writeConfig(file, CONFIG);
    const huge = { ...CONFIG, workspaceRoot: "x" };
    // Make serialisation fail midway through the write.
    Object.defineProperty(huge, "toJSON", {
      value: () => {
        throw new Error("disk full");
      },
    });
    await expect(writeConfig(file, huge)).rejects.toThrow("disk full");
    expect(await readConfig(file)).toEqual(CONFIG);
    expect(await readdir(path.dirname(file))).toEqual(["agent.json"]);
  });

  it.each([0o640, 0o604, 0o644, 0o660])("refuses a config file with mode %o", async (mode) => {
    await writeConfig(file, CONFIG);
    await chmod(file, mode);
    await expect(readConfig(file)).rejects.toThrow(/accessible by group or others/);
  });

  it("reports a missing or invalid config", async () => {
    await expect(readConfig(file)).rejects.toThrow(/enroll/);
    await writeConfig(file, CONFIG);
    await writeFile(file, "{", { mode: 0o600 });
    await expect(readConfig(file)).rejects.toThrow(/not valid JSON/);
    await writeFile(file, JSON.stringify({ server: "https://x" }), { mode: 0o600 });
    await expect(readConfig(file)).rejects.toThrow(/not a valid agent config/);
    await writeFile(file, JSON.stringify({ ...CONFIG, server: "http://evil.example" }));
    await expect(readConfig(file)).rejects.toThrow(/https/);
    expect(await readFile(file, "utf8")).toContain("evil");
  });
});

describe("execPathBlocked", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-exec-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks nothing by default", async () => {
    expect(await execPathBlocked(CONFIG, "/usr/bin/env")).toBe(false);
  });

  it("matches whole path segments", async () => {
    const config = { ...CONFIG, blockedExecPaths: ["/opt/x"] };
    expect(await execPathBlocked(config, "/opt/x")).toBe(true);
    expect(await execPathBlocked(config, "/opt/x/bin/tool")).toBe(true);
    expect(await execPathBlocked(config, "/opt/x/../x/tool")).toBe(true);
    expect(await execPathBlocked(config, "/opt/xy/tool")).toBe(false);
    expect(await execPathBlocked(config, "/opt")).toBe(false);
    expect(await execPathBlocked({ ...config, blockedExecPaths: ["/opt/x/"] }, "/opt/x/t")).toBe(
      true,
    );
  });

  it("resolves symlinks on both sides", async () => {
    const blocked = path.join(dir, "blocked");
    await mkdir(path.join(blocked, "bin"), { recursive: true });
    await writeFile(path.join(blocked, "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 });
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    // A link outside the blocked prefix pointing into it.
    await symlink(path.join(blocked, "bin", "tool"), path.join(outside, "tool"));
    await symlink(path.join(blocked, "bin"), path.join(outside, "bindir"));
    const config = { ...CONFIG, blockedExecPaths: [blocked] };
    expect(await execPathBlocked(config, path.join(outside, "tool"))).toBe(true);
    expect(await execPathBlocked(config, path.join(outside, "bindir", "tool"))).toBe(true);
    expect(await execPathBlocked(config, path.join(outside, "bindir", "missing"))).toBe(true);
    expect(await execPathBlocked(config, path.join(outside, "missing"))).toBe(false);

    // A blocked prefix that is itself a link covers its target.
    const link = path.join(dir, "link-to-blocked");
    await symlink(blocked, link);
    const viaLink = { ...CONFIG, blockedExecPaths: [link] };
    expect(await execPathBlocked(viaLink, path.join(blocked, "bin", "tool"))).toBe(true);
    expect(await execPathBlocked(viaLink, path.join(outside, "tool"))).toBe(true);
    expect(await execPathBlocked(viaLink, path.join(outside, "missing"))).toBe(false);
  });
});

describe("defaultConfigPath", () => {
  it("is ~/.config/omniralph/agent.json", () => {
    expect(defaultConfigPath("/home/h")).toBe("/home/h/.config/omniralph/agent.json");
  });
});

describe("dataDir", () => {
  it("defaults to the parent of the default workspace root", () => {
    expect(defaultDataDir("/home/h")).toBe("/home/h/.omniralph");
    expect(path.dirname(defaultWorkspaceRoot("/home/h"))).toBe(defaultDataDir("/home/h"));
    expect(dataDir(CONFIG, "/home/h")).toBe("/home/h/.omniralph");
    expect(dataDir({ ...CONFIG, dataDir: "/srv/omniralph" }, "/home/h")).toBe("/srv/omniralph");
  });
});

describe("config file settings", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-config-"));
    file = path.join(dir, "agent.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeRaw(value: unknown): Promise<void> {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  }

  it("loads a file written before the optional keys existed, with the defaults", async () => {
    await writeRaw(CONFIG);
    const config = await readConfig(file);
    expect(config).toEqual(CONFIG);
    expect(await execPathBlocked(config, "/usr/bin/env")).toBe(false);
    expect(dataDir(config, "/home/h")).toBe("/home/h/.omniralph");
    // Rewriting it (as token rotation does) doesn't add the new keys.
    await writeConfig(file, { ...config, refreshToken: "next" });
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")) as object).sort()).toEqual([
      "agentId",
      "refreshToken",
      "server",
      "workspaceRoot",
    ]);
  });

  it("loads and keeps the optional keys when set", async () => {
    const withKeys = {
      ...CONFIG,
      dataDir: "/srv/omniralph",
      blockedExecPaths: ["/opt/untrusted"],
      ui: { enabled: true, port: 7411, allowedHosts: ["coder.example.com", "localhost"] },
    };
    await writeRaw(withKeys);
    const config = await readConfig(file);
    expect(config).toEqual(withKeys);
    await writeConfig(file, config);
    expect(await readConfig(file)).toEqual(withKeys);
    await writeRaw({ ...CONFIG, ui: {} });
    expect((await readConfig(file)).ui).toEqual({});
  });

  it.each([
    ["acceptedTaskTypes", { acceptedTaskTypes: ["review"] }],
    ["installables", { installables: { allow: ["@acme/*"] } }],
    ["installables", { installables: {} }],
  ])("refuses a config that still has %s, pointing at settings.json", async (key, extra) => {
    await writeRaw({ ...CONFIG, ...extra });
    await expect(readConfig(file)).rejects.toThrow(`${key} moved to settings.json`);
  });

  it("names every moved key and every other issue", async () => {
    await writeRaw({
      ...CONFIG,
      acceptedTaskTypes: ["review"],
      installables: { allow: [] },
      dataDir: "data",
    });
    const error = await readConfig(file).catch((e: Error) => e);
    expect((error as Error).message).toMatch(
      /acceptedTaskTypes moved to settings\.json; installables moved to settings\.json; dataDir: must be an absolute path/,
    );
  });

  it.each([
    [{ port: 0 }, "ui.port"],
    [{ port: 65536 }, "ui.port"],
    [{ port: 80.5 }, "ui.port"],
    [{ enabled: "yes" }, "ui.enabled"],
    [{ allowedHosts: ["http://coder.example"] }, "ui.allowedHosts.0"],
    [{ allowedHosts: ["coder.example:7410"] }, "ui.allowedHosts.0"],
    [{ allowedHosts: "coder.example" }, "ui.allowedHosts"],
  ])("rejects ui %j naming the key", async (ui, key) => {
    await writeRaw({ ...CONFIG, ui });
    await expect(readConfig(file)).rejects.toThrow(key);
  });

  it("rejects relative blocked paths and data dir naming the key", async () => {
    await writeRaw({ ...CONFIG, blockedExecPaths: ["/ok", "bin"] });
    await expect(readConfig(file)).rejects.toThrow(/blockedExecPaths\.1: must be an absolute path/);
    await writeRaw({ ...CONFIG, dataDir: "data" });
    await expect(readConfig(file)).rejects.toThrow(/dataDir/);
  });
});
