import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JobPayload } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import {
  installablePackageDir,
  listInstalledInstallables,
  npmInstallableInstaller,
  readInstalledPackage,
  type InstallableInstaller,
} from "../installables.js";
import { silentLogger } from "../logger.js";
import { SystemRpcRegistry, defaultSystemRpcs, type SystemRpcContext } from "./index.js";
import { installRpc } from "./install.js";

const CONFIG: AgentConfig = {
  server: "https://omniralph.example",
  agentId: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
  refreshToken: "refresh",
  workspaceRoot: "/tmp/unused",
};
const FIXTURE = fileURLToPath(new URL("../test/fixtures/installables/hello", import.meta.url));
const FIXTURE_1_1 = fileURLToPath(
  new URL("../test/fixtures/installables/hello-1.1.0", import.meta.url),
);

function installJob(payload: JobPayload["payload"]): JobPayload {
  return {
    id: "7f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
    type: "install",
    taskType: "system",
    pool: null,
    taskId: null,
    repositoryId: null,
    payload,
    deliveryCount: 1,
  };
}

function context(): SystemRpcContext {
  return {
    signal: new AbortController().signal,
    jobToken: () => "job-token",
    env: () => ({ OMNIRALPH_JOB_TOKEN: "job-token" }),
    spawn: () => {
      throw new Error("install spawns nothing through the job");
    },
    server: "https://omniralph.example",
    workspaceRoot: "/tmp/unused",
    repos: {} as SystemRpcContext["repos"],
    logger: silentLogger(),
  };
}

/** Writes `package.json` of `name` into the prefix, as npm would install it. */
async function placePackage(prefix: string, packageJson: Record<string, unknown>): Promise<void> {
  const dir = installablePackageDir(prefix, packageJson.name as string);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson));
}

const manifest = { commands: [{ name: "hello", bin: "bin/hello.js" }] };

describe("install", () => {
  let root: string;
  let prefix: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-install-"));
    prefix = path.join(root, "data", "installables");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** An installer that "installs" `published[name@version]` into the prefix. */
  function fakeInstaller(published: Record<string, Record<string, unknown>>) {
    return {
      install: vi.fn<InstallableInstaller["install"]>(async (name, version, into) => {
        const pkg = published[`${name}@${version}`];
        if (!pkg) throw new Error(`npm install ${name}@${version} failed: E404`);
        await placePackage(into, pkg);
      }),
      uninstall: vi.fn<InstallableInstaller["uninstall"]>(async (name, from) => {
        await rm(installablePackageDir(from, name), { recursive: true, force: true });
      }),
    };
  }

  it("is in the registry when the agent has its config", () => {
    const installer = fakeInstaller({});
    expect(new SystemRpcRegistry(defaultSystemRpcs()).get("install")).toBeUndefined();
    const registry = new SystemRpcRegistry(
      defaultSystemRpcs({ config: CONFIG, prefix, installer }),
    );
    expect(registry.names()).toEqual(["repo.sync", "worktree.exec", "worktree.cleanup", "install"]);
  });

  it("installs an allowed installable into the prefix and reports its version", async () => {
    const installer = fakeInstaller({
      "@omniralph/hello@latest": {
        name: "@omniralph/hello",
        version: "1.0.0",
        omniralph: manifest,
      },
      "@omniralph/hello@1.1.0": { name: "@omniralph/hello", version: "1.1.0", omniralph: manifest },
    });
    const rpc = installRpc({ config: CONFIG, prefix, installer });

    expect(await rpc.run(installJob({ name: "@omniralph/hello" }), context())).toEqual({
      name: "@omniralph/hello",
      version: "1.0.0",
      changed: true,
      commands: ["hello"],
      mcpServers: [],
      skills: 0,
    });
    expect(installer.install).toHaveBeenCalledWith("@omniralph/hello", "latest", prefix, {
      signal: expect.any(AbortSignal),
    });
    // The prefix is the agent's own npm project, not the agent package's or a global one.
    expect(JSON.parse(await readFile(path.join(prefix, "package.json"), "utf8"))).toEqual({
      name: "omniralph-installables",
      private: true,
    });

    expect(
      await rpc.run(installJob({ name: "@omniralph/hello", version: "1.1.0" }), context()),
    ).toMatchObject({ name: "@omniralph/hello", version: "1.1.0", changed: true });
    expect(
      await rpc.run(installJob({ name: "@omniralph/hello", version: "1.1.0" }), context()),
    ).toMatchObject({ name: "@omniralph/hello", version: "1.1.0", changed: false });
  });

  it("refuses a package the local allowlist doesn't allow, before npm runs", async () => {
    const installer = fakeInstaller({
      "evil@latest": { name: "evil", version: "1.0.0", omniralph: manifest },
    });
    const rpc = installRpc({ config: CONFIG, prefix, installer });
    await expect(rpc.run(installJob({ name: "evil" }), context())).rejects.toThrow(
      /evil isn't allowed on this agent/,
    );
    await expect(rpc.run(installJob({ name: "@omniralph-evil/x" }), context())).rejects.toThrow(
      /isn't allowed/,
    );

    // An empty allowlist allows nothing, not even @omniralph packages.
    const none = installRpc({
      config: { ...CONFIG, installables: { allow: [] } },
      prefix,
      installer,
    });
    await expect(none.run(installJob({ name: "@omniralph/hello" }), context())).rejects.toThrow(
      /isn't allowed/,
    );
    expect(installer.install).not.toHaveBeenCalled();
  });

  it("installs what the owner's allowlist allows instead of the default", async () => {
    const installer = fakeInstaller({
      "@acme/graph@2.0.0": { name: "@acme/graph", version: "2.0.0", omniralph: manifest },
    });
    const config = { ...CONFIG, installables: { allow: ["@acme/*"] } };
    const rpc = installRpc({ config, prefix, installer });
    expect(
      await rpc.run(installJob({ name: "@acme/graph", version: "2.0.0" }), context()),
    ).toMatchObject({ name: "@acme/graph", version: "2.0.0" });
    await expect(rpc.run(installJob({ name: "@omniralph/hello" }), context())).rejects.toThrow(
      /isn't allowed/,
    );
  });

  it("rejects an invalid payload without running npm", async () => {
    const installer = fakeInstaller({});
    const rpc = installRpc({ config: CONFIG, prefix, installer });
    for (const payload of [
      {},
      { name: "@omniralph/x", version: "npm:evil@1.0.0" },
      { name: "@omniralph/x", version: "file:/tmp/evil" },
      { name: "-g" },
    ]) {
      await expect(rpc.run(installJob(payload), context())).rejects.toThrow(
        "invalid install payload",
      );
    }
    expect(installer.install).not.toHaveBeenCalled();
  });

  it("removes a package that isn't an installable and fails", async () => {
    const installer = fakeInstaller({
      "@omniralph/plain@latest": { name: "@omniralph/plain", version: "1.0.0" },
    });
    const rpc = installRpc({ config: CONFIG, prefix, installer });
    await expect(rpc.run(installJob({ name: "@omniralph/plain" }), context())).rejects.toThrow(
      /@omniralph\/plain@latest isn't a valid installable: Not an installable/,
    );
    expect(installer.uninstall).toHaveBeenCalledWith("@omniralph/plain", prefix, {
      signal: expect.any(AbortSignal),
    });
    expect(await readInstalledPackage(prefix, "@omniralph/plain")).toBeNull();
  });

  it("restores the version installed before when the new one isn't a valid installable", async () => {
    const installer = fakeInstaller({
      "@omniralph/hello@1.0.0": { name: "@omniralph/hello", version: "1.0.0", omniralph: manifest },
      "@omniralph/hello@2.0.0": {
        name: "@omniralph/hello",
        version: "2.0.0",
        omniralph: { commands: [{ name: "hello", bin: "../escape.js" }] },
      },
    });
    const rpc = installRpc({ config: CONFIG, prefix, installer });
    await rpc.run(installJob({ name: "@omniralph/hello", version: "1.0.0" }), context());
    await expect(
      rpc.run(installJob({ name: "@omniralph/hello", version: "2.0.0" }), context()),
    ).rejects.toThrow(/isn't a valid installable: Invalid omniralph field/);
    expect(installer.uninstall).not.toHaveBeenCalled();
    const restored = await readInstalledPackage(prefix, "@omniralph/hello");
    expect(restored).toMatchObject({ ok: true, installable: { version: "1.0.0" } });
  });

  it("fails with npm's error and runs installs one at a time", async () => {
    let running = 0;
    let most = 0;
    const installer: InstallableInstaller = {
      install: async (name, version, into) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        if (version === "9.9.9") throw new Error("npm install failed: E404");
        await placePackage(into, { name, version, omniralph: manifest });
      },
      uninstall: async () => {},
    };
    const rpc = installRpc({ config: CONFIG, prefix, installer });
    const results = await Promise.allSettled([
      rpc.run(installJob({ name: "@omniralph/a", version: "1.0.0" }), context()),
      rpc.run(installJob({ name: "@omniralph/b", version: "9.9.9" }), context()),
      rpc.run(installJob({ name: "@omniralph/c", version: "1.0.0" }), context()),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((results[1] as PromiseRejectedResult).reason).toEqual(
      new Error("npm install failed: E404"),
    );
    expect(most).toBe(1);
  });

  /** Packs a fixture installable with `npm pack` into `<root>/pack`; returns the tarball. */
  async function pack(fixture: string): Promise<string> {
    const packDir = path.join(root, "pack");
    await mkdir(packDir, { recursive: true });
    const tarballName = execFileSync("npm", ["pack", fixture, "--pack-destination", packDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .pop()!;
    return path.join(packDir, tarballName);
  }

  // No network: npm's registry is an address nothing listens on.
  const NO_REGISTRY_ENV = { ...process.env, npm_config_registry: "http://127.0.0.1:9/" };

  // Runs real npm without network: the packages come from local tarballs.
  it(
    "installs and updates a packed installable with npm into the prefix",
    { timeout: 180_000 },
    async () => {
      const tarballs: Record<string, string> = {
        "@omniralph/hello@1.0.0": await pack(FIXTURE),
        "@omniralph/hello@1.1.0": await pack(FIXTURE_1_1),
      };
      // The real npm installer, with the registry spec mapped to the tarball.
      const installer = npmInstallableInstaller(NO_REGISTRY_ENV, (name, version) => {
        const tarball = tarballs[`${name}@${version}`];
        if (!tarball) throw new Error(`no tarball for ${name}@${version}`);
        return tarball;
      });
      const rpc = installRpc({ config: CONFIG, prefix, installer });
      const dataDir = path.dirname(prefix);
      const bin = path.join(installablePackageDir(prefix, "@omniralph/hello"), "bin", "hello.js");

      expect(
        await rpc.run(installJob({ name: "@omniralph/hello", version: "1.0.0" }), context()),
      ).toEqual({
        name: "@omniralph/hello",
        version: "1.0.0",
        changed: true,
        commands: ["hello"],
        mcpServers: [],
        skills: 0,
      });
      expect(execFileSync(bin, { encoding: "utf8" })).toBe("hello from an installable\n");
      expect(await listInstalledInstallables(dataDir)).toEqual([
        { name: "@omniralph/hello", version: "1.0.0" },
      ]);

      // An update replaces the installed version.
      expect(
        await rpc.run(installJob({ name: "@omniralph/hello", version: "1.1.0" }), context()),
      ).toEqual({
        name: "@omniralph/hello",
        version: "1.1.0",
        changed: true,
        commands: ["hello"],
        mcpServers: ["hello"],
        skills: 0,
      });
      expect(execFileSync(bin, { encoding: "utf8" })).toBe("hello from an updated installable\n");
      expect(await listInstalledInstallables(dataDir)).toEqual([
        { name: "@omniralph/hello", version: "1.1.0" },
      ]);
      expect(JSON.parse(await readFile(path.join(prefix, "package.json"), "utf8"))).toMatchObject({
        dependencies: { "@omniralph/hello": expect.any(String) },
      });
    },
  );

  it("fails with the tail of npm's stderr", { timeout: 120_000 }, async () => {
    const installer = npmInstallableInstaller(NO_REGISTRY_ENV, () =>
      path.join(root, "missing.tgz"),
    );
    const rpc = installRpc({ config: CONFIG, prefix, installer });
    await expect(rpc.run(installJob({ name: "@omniralph/hello" }), context())).rejects.toThrow(
      /^npm install --save-exact -- .*missing\.tgz failed: (.|\n)*npm error/,
    );
  });
});
