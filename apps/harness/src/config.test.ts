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
  defaultDataDir,
  defaultWorkspaceRoot,
  execPathBlocked,
  installableAllowed,
  readConfig,
  validateServerUrl,
  writeConfig,
  type HarnessConfig,
} from "./config.js";

const CONFIG: HarnessConfig = {
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
    file = path.join(dir, "nested", "harness.json");
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
    expect(await readdir(path.dirname(file))).toEqual(["harness.json"]);
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
    expect(await readdir(path.dirname(file))).toEqual(["harness.json"]);
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

describe("installableAllowed", () => {
  it("defaults to the @omniralph scope", () => {
    expect(installableAllowed(CONFIG, "@omniralph/codegraph")).toBe(true);
    expect(installableAllowed(CONFIG, "@omniralph-evil/x")).toBe(false);
    expect(installableAllowed(CONFIG, "codegraph")).toBe(false);
    expect(installableAllowed(CONFIG, "@omniralph/a/b")).toBe(false);
    expect(installableAllowed({ ...CONFIG, installables: {} }, "@omniralph/codegraph")).toBe(true);
  });

  it("matches exact names and scope wildcards", () => {
    const config = { ...CONFIG, installables: { allow: ["semgrep-mcp", "@acme/*", "@x/tool-*"] } };
    expect(installableAllowed(config, "semgrep-mcp")).toBe(true);
    expect(installableAllowed(config, "semgrep-mcp-extra")).toBe(false);
    expect(installableAllowed(config, "@acme/anything")).toBe(true);
    expect(installableAllowed(config, "@acme2/anything")).toBe(false);
    expect(installableAllowed(config, "@x/tool-graph")).toBe(true);
    expect(installableAllowed(config, "@x/other")).toBe(false);
    expect(installableAllowed(config, "@omniralph/codegraph")).toBe(false);
  });

  it("treats regex characters literally and an empty list as allowing nothing", () => {
    expect(installableAllowed({ ...CONFIG, installables: { allow: ["a.b"] } }, "axb")).toBe(false);
    expect(installableAllowed({ ...CONFIG, installables: { allow: [] } }, "@omniralph/x")).toBe(
      false,
    );
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
    file = path.join(dir, "harness.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeRaw(value: unknown): Promise<void> {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  }

  it("loads a file written before the settings existed, with the defaults", async () => {
    await writeRaw(CONFIG);
    const config = await readConfig(file);
    expect(config).toEqual(CONFIG);
    expect(installableAllowed(config, "@omniralph/codegraph")).toBe(true);
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

  it("loads and keeps the settings when set", async () => {
    const withSettings = {
      ...CONFIG,
      dataDir: "/srv/omniralph",
      installables: { allow: ["@acme/*", "semgrep-mcp"] },
      blockedExecPaths: ["/opt/untrusted"],
    };
    await writeRaw(withSettings);
    const config = await readConfig(file);
    expect(config).toEqual(withSettings);
    await writeConfig(file, config);
    expect(await readConfig(file)).toEqual(withSettings);
  });

  it.each(["", " ", "@a/ b", "@a/b/c", "a//b"])(
    "rejects the installable pattern %j naming the key",
    async (pattern) => {
      await writeRaw({ ...CONFIG, installables: { allow: [pattern] } });
      await expect(readConfig(file)).rejects.toThrow(/installables\.allow/);
    },
  );

  it("rejects relative blocked paths and data dir naming the key", async () => {
    await writeRaw({ ...CONFIG, blockedExecPaths: ["/ok", "bin"] });
    await expect(readConfig(file)).rejects.toThrow(/blockedExecPaths\.1: must be an absolute path/);
    await writeRaw({ ...CONFIG, dataDir: "data" });
    await expect(readConfig(file)).rejects.toThrow(/dataDir/);
    await writeRaw({ ...CONFIG, installables: { allow: "@omniralph/*" } });
    await expect(readConfig(file)).rejects.toThrow(/installables\.allow/);
  });
});
