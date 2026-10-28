import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobPayload } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NpmError,
  installablePackageDir,
  listInstalledInstallables,
  type InstallableInstaller,
} from "../installables.js";
import { silentLogger } from "../logger.js";
import { installRpc } from "../rpc/install.js";
import type { SystemRpcContext } from "../rpc/index.js";
import { InstallHistory, installsPath, type InstallSummary } from "./history.js";
import { PackageManager, PackageNotAllowedError, PackageNotInstalledError } from "./manager.js";

const manifest = { commands: [{ name: "hello", bin: "bin/hello.js" }] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("PackageManager", () => {
  let root: string;
  let dataDir: string;
  let prefix: string;
  let history: InstallHistory;
  let changes: InstallSummary[];
  let allow: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-packages-"));
    dataDir = path.join(root, "data");
    prefix = path.join(dataDir, "installables");
    let id = 0;
    history = new InstallHistory({
      file: installsPath(dataDir),
      logger: silentLogger(),
      newId: () => `install-${++id}`,
    });
    changes = [];
    history.on("change", (change) => changes.push(change));
    allow = ["@omniralph/*"];
  });

  afterEach(async () => {
    await history.flush();
    await rm(root, { recursive: true, force: true });
  });

  /** Writes the package and its dependency entry into the prefix, as `npm install --save-exact` would. */
  async function place(pkg: Record<string, unknown>): Promise<void> {
    const name = pkg.name as string;
    const dir = installablePackageDir(prefix, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
    await setDependency(name, pkg.version as string);
  }

  async function setDependency(name: string, version: string | null): Promise<void> {
    const file = path.join(prefix, "package.json");
    const json = JSON.parse(await readFile(file, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = { ...json.dependencies };
    if (version === null) delete dependencies[name];
    else dependencies[name] = version;
    await writeFile(file, JSON.stringify({ ...json, dependencies }));
  }

  /** An npm that "installs" `published[name@version]` and prints what it did. */
  function fakeNpm(published: Record<string, Record<string, unknown>>) {
    return {
      install: vi.fn<InstallableInstaller["install"]>(async (name, version) => {
        const pkg = published[`${name}@${version}`];
        if (!pkg)
          throw new NpmError(`npm install ${name}@${version} failed: E404`, "npm error 404");
        await place(pkg);
        return `added 1 package: ${name}@${pkg.version as string}`;
      }),
      uninstall: vi.fn<InstallableInstaller["uninstall"]>(async (name) => {
        await rm(installablePackageDir(prefix, name), { recursive: true, force: true });
        await setDependency(name, null);
        return `removed 1 package: ${name}`;
      }),
    };
  }

  function manager(installer: InstallableInstaller) {
    return new PackageManager({
      allowList: () => allow,
      prefix,
      installer,
      history,
      logger: silentLogger(),
    });
  }

  it("installs, updates to latest and removes, recording each with npm's output", async () => {
    const npm = fakeNpm({
      "@omniralph/hello@1.0.0": { name: "@omniralph/hello", version: "1.0.0", omniralph: manifest },
      "@omniralph/hello@latest": {
        name: "@omniralph/hello",
        version: "1.1.0",
        omniralph: manifest,
      },
    });
    const packages = manager(npm);

    const install = packages.install({ name: "@omniralph/hello", version: "1.0.0", from: "local" });
    // Recorded before npm ran: the page shows it at once.
    expect(install.record).toEqual({
      id: "install-1",
      action: "install",
      name: "@omniralph/hello",
      version: "1.0.0",
      installedVersion: null,
      previousVersion: null,
      from: "local",
      startedAt: expect.any(String),
      finishedAt: null,
      outcome: null,
      error: null,
    });
    expect(await install.done).toMatchObject({ version: "1.0.0", changed: true });
    expect(await packages.installed()).toEqual([{ name: "@omniralph/hello", version: "1.0.0" }]);
    // What the next heartbeat reports.
    expect(await listInstalledInstallables(dataDir)).toEqual([
      { name: "@omniralph/hello", version: "1.0.0" },
    ]);
    expect(history.get("install-1")).toMatchObject({
      outcome: "installed",
      installedVersion: "1.0.0",
      finishedAt: expect.any(String),
      output: "added 1 package: @omniralph/hello@1.0.0",
    });

    // Update: the per-row button installs `latest`.
    const update = packages.install({ name: "@omniralph/hello", from: "local" });
    expect(update.record.version).toBe("latest");
    expect(await update.done).toMatchObject({ version: "1.1.0", changed: true });
    expect(history.get(update.record.id)).toMatchObject({
      outcome: "installed",
      previousVersion: "1.0.0",
      installedVersion: "1.1.0",
    });
    expect(await listInstalledInstallables(dataDir)).toEqual([
      { name: "@omniralph/hello", version: "1.1.0" },
    ]);

    // Removal uses npm's uninstall.
    const removal = await packages.remove({ name: "@omniralph/hello", from: "local" });
    expect(removal.record).toMatchObject({
      action: "remove",
      name: "@omniralph/hello",
      version: null,
      previousVersion: "1.1.0",
      outcome: null,
    });
    await removal.done;
    expect(npm.uninstall).toHaveBeenCalledWith("@omniralph/hello", prefix);
    expect(history.get(removal.record.id)).toMatchObject({
      outcome: "removed",
      output: "removed 1 package: @omniralph/hello",
    });
    expect(await listInstalledInstallables(dataDir)).toEqual([]);

    // Newest first; each change was published as it started and finished.
    expect(history.list().map((r) => [r.action, r.outcome])).toEqual([
      ["remove", "removed"],
      ["install", "installed"],
      ["install", "installed"],
    ]);
    expect(changes.map((c) => `${c.id}:${c.outcome ?? "queued"}`)).toEqual([
      "install-1:queued",
      "install-1:installed",
      "install-2:queued",
      "install-2:installed",
      "install-3:queued",
      "install-3:removed",
    ]);
    await history.flush();
    const saved = JSON.parse(await readFile(installsPath(dataDir), "utf8")) as {
      installs: unknown[];
    };
    expect(saved.installs).toHaveLength(3);
  });

  it("refuses a package the allow-list doesn't match before npm runs, and records it", async () => {
    const npm = fakeNpm({});
    const packages = manager(npm);
    expect(() => packages.install({ name: "evil", from: "local" })).toThrow(PackageNotAllowedError);
    allow = [];
    expect(() => packages.install({ name: "@omniralph/hello", from: "local" })).toThrow(
      /@omniralph\/hello isn't allowed on this agent/,
    );
    expect(npm.install).not.toHaveBeenCalled();
    expect(history.list()).toEqual([
      expect.objectContaining({
        name: "@omniralph/hello",
        outcome: "failed",
        error: expect.stringMatching(/isn't allowed/),
      }),
      expect.objectContaining({ name: "evil", outcome: "failed" }),
    ]);
  });

  it("rolls back a package without a valid manifest and records npm's error output", async () => {
    const npm = fakeNpm({
      "@omniralph/plain@latest": { name: "@omniralph/plain", version: "1.0.0" },
    });
    const packages = manager(npm);
    const { record, done } = packages.install({ name: "@omniralph/plain", from: "local" });
    await expect(done).rejects.toThrow(/isn't a valid installable/);
    expect(npm.uninstall).toHaveBeenCalledWith("@omniralph/plain", prefix, {
      signal: undefined,
    });
    expect(await packages.installed()).toEqual([]);
    expect(history.get(record.id)).toMatchObject({
      outcome: "failed",
      error: expect.stringMatching(/@omniralph\/plain@latest isn't a valid installable/),
      output: "added 1 package: @omniralph/plain@1.0.0\nremoved 1 package: @omniralph/plain",
    });

    // npm failing: its output is kept.
    const missing = packages.install({ name: "@omniralph/nope", version: "9.9.9", from: "local" });
    await expect(missing.done).rejects.toThrow(/E404/);
    expect(history.get(missing.record.id)).toMatchObject({
      outcome: "failed",
      output: "npm error 404",
    });
  });

  it("refuses to remove a package that isn't installed", async () => {
    const npm = fakeNpm({});
    await expect(
      manager(npm).remove({ name: "@omniralph/hello", from: "local" }),
    ).rejects.toBeInstanceOf(PackageNotInstalledError);
    expect(npm.uninstall).not.toHaveBeenCalled();
    expect(history.list()).toEqual([]);
  });

  it("runs the page's and Fleet's installs through one queue, one at a time", async () => {
    const gate = deferred();
    let running = 0;
    let most = 0;
    const installer: InstallableInstaller = {
      install: async (name, version) => {
        running += 1;
        most = Math.max(most, running);
        if (name === "@omniralph/a") await gate.promise;
        running -= 1;
        await place({
          name,
          version: version === "latest" ? "1.0.0" : version,
          omniralph: manifest,
        });
      },
      uninstall: async () => {},
    };
    const packages = manager(installer);
    const local = packages.install({ name: "@omniralph/a", from: "local" });
    const job = {
      id: "7f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
      type: "install",
      taskType: "system",
      pool: null,
      taskId: null,
      repositoryId: null,
      payload: { name: "@omniralph/b", version: "2.0.0" },
      deliveryCount: 1,
    } satisfies JobPayload;
    const fleet = installRpc({ packages }).run(job, {
      signal: new AbortController().signal,
      logger: silentLogger(),
    } as SystemRpcContext);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Fleet's waits for the page's.
    expect(history.list().map((r) => [r.name, r.from, r.outcome])).toEqual([
      ["@omniralph/b", "fleet", null],
      ["@omniralph/a", "local", null],
    ]);
    gate.resolve();
    await local.done;
    expect(await fleet).toMatchObject({ name: "@omniralph/b", version: "2.0.0" });
    expect(most).toBe(1);
    expect(history.list().map((r) => r.outcome)).toEqual(["installed", "installed"]);
  });
});

describe("InstallHistory", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-installs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the last 50 with output capped at 64 KB, and survives a restart", async () => {
    const file = installsPath(root);
    const history = new InstallHistory({ file, logger: silentLogger() });
    for (let i = 0; i < 52; i++) {
      const { id } = history.start({
        action: "install",
        name: `@omniralph/p${i}`,
        version: "latest",
        previousVersion: null,
        from: i % 2 ? "fleet" : "local",
      });
      history.finish(id, {
        outcome: "installed",
        installedVersion: "1.0.0",
        output: i === 51 ? `first line\n${"x".repeat(70 * 1024)}\nlast line` : "ok",
      });
    }
    const list = history.list();
    expect(list).toHaveLength(50);
    expect(list[0]).toMatchObject({ name: "@omniralph/p51", from: "fleet" });
    expect(list.at(-1)).toMatchObject({ name: "@omniralph/p2", from: "local" });
    expect(list[0]).not.toHaveProperty("output");
    const output = history.get(list[0]!.id)!.output;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1024);
    expect(output.endsWith("last line")).toBe(true);
    expect(output).not.toContain("first line");
    await history.flush();
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");

    const again = new InstallHistory({ file, logger: silentLogger() });
    await again.load();
    expect(again.list()).toEqual(list);
    expect(again.get(list[0]!.id)!.output).toBe(output);
  });

  it("marks installs the agent stopped in the middle of as failed on load", async () => {
    const file = installsPath(root);
    const history = new InstallHistory({ file, logger: silentLogger() });
    history.start({
      action: "install",
      name: "@omniralph/hello",
      version: "latest",
      previousVersion: null,
      from: "local",
    });
    await history.flush();
    const again = new InstallHistory({ file, logger: silentLogger() });
    await again.load();
    expect(again.list()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        error: "The agent stopped before this finished.",
        finishedAt: expect.any(String),
      }),
    ]);
  });

  it("starts empty from a missing or invalid file", async () => {
    const file = installsPath(root);
    const missing = new InstallHistory({ file, logger: silentLogger() });
    await missing.load();
    expect(missing.list()).toEqual([]);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `{"v":1,"installs":[{"id":1}]}`);
    const invalid = new InstallHistory({ file, logger: silentLogger() });
    await invalid.load();
    expect(invalid.list()).toEqual([]);
  });
});
