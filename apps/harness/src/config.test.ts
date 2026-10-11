import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, validateServerUrl, writeConfig, type AgentConfig } from "./config.js";

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
