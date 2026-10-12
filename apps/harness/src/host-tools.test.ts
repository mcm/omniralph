import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostToolPaths,
  effectiveHostToolPath,
  findOnPath,
  isExecutableFile,
} from "./host-tools.js";
import { silentLogger } from "./logger.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "omniralph-host-tools-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes a stub executable (or, with `mode`, a file of that mode) and returns its path. */
async function stub(relative: string, mode = 0o755): Promise<string> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\necho stub\n");
  await chmod(file, mode);
  return file;
}

describe("isExecutableFile", () => {
  it("accepts executable regular files and links to them only", async () => {
    const tool = await stub("bin/tool");
    expect(await isExecutableFile(tool)).toBe(true);
    expect(await isExecutableFile(await stub("bin/data", 0o644))).toBe(false);
    expect(await isExecutableFile(path.join(root, "bin"))).toBe(false);
    expect(await isExecutableFile(path.join(root, "bin/missing"))).toBe(false);
    await symlink(tool, path.join(root, "link"));
    expect(await isExecutableFile(path.join(root, "link"))).toBe(true);
  });
});

describe("findOnPath", () => {
  it("returns the first executable match in PATH order", async () => {
    const first = path.join(root, "first");
    await mkdir(first);
    await stub("first/other");
    // Not executable: skipped.
    await stub("second/tool", 0o644);
    const third = await stub("third/tool");
    await stub("fourth/tool");
    const searchPath = [
      first,
      "second",
      path.join(root, "second"),
      path.join(root, "third"),
      path.join(root, "fourth"),
    ].join(path.delimiter);
    expect(await findOnPath({}, "tool", searchPath)).toBe(third);
    expect(await findOnPath({}, "missing", searchPath)).toBeNull();
    expect(await findOnPath({}, "tool", undefined)).toBeNull();
  });

  it("skips relative PATH entries", async () => {
    await stub("rel/tool");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(await findOnPath({}, "tool", ["rel", "", "."].join(path.delimiter))).toBeNull();
    } finally {
      cwd.mockRestore();
    }
  });

  it("skips candidates covered by blockedExecPaths, links included", async () => {
    await stub("blocked/tool");
    const allowed = await stub("allowed/tool");
    const blocked = path.join(root, "blocked");
    const searchPath = [blocked, path.join(root, "allowed")].join(path.delimiter);
    expect(await findOnPath({ blockedExecPaths: [blocked] }, "tool", searchPath)).toBe(allowed);
    expect(
      await findOnPath(
        { blockedExecPaths: [blocked, path.join(root, "allowed")] },
        "tool",
        searchPath,
      ),
    ).toBeNull();
    // A PATH directory that links into a blocked one is blocked too.
    await symlink(blocked, path.join(root, "via-link"));
    expect(
      await findOnPath({ blockedExecPaths: [blocked] }, "tool", path.join(root, "via-link")),
    ).toBeNull();
  });

  it("never looks up a name with a path in it", async () => {
    await stub("bin/sub/tool");
    expect(await findOnPath({}, "sub/tool", path.join(root, "bin"))).toBeNull();
    expect(await findOnPath({}, "..", path.join(root, "bin"))).toBeNull();
  });
});

describe("effectiveHostToolPath", () => {
  it("uses a usable configured path, never falls back, else the discovered one", () => {
    const discovered = "/usr/bin/tool";
    expect(
      effectiveHostToolPath("/opt/tool", {
        configuredPathExists: true,
        discoveredPath: discovered,
      }),
    ).toBe("/opt/tool");
    expect(
      effectiveHostToolPath("/opt/tool", {
        configuredPathExists: false,
        discoveredPath: discovered,
      }),
    ).toBeNull();
    expect(
      effectiveHostToolPath(null, { configuredPathExists: null, discoveredPath: discovered }),
    ).toBe(discovered);
    expect(
      effectiveHostToolPath(null, { configuredPathExists: null, discoveredPath: null }),
    ).toBeNull();
  });
});

describe("HostToolPaths", () => {
  function paths(blockedExecPaths: string[] = [], searchPath = path.join(root, "path")) {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, "warn");
    const hostTools = new HostToolPaths({
      config: { blockedExecPaths },
      searchPath: () => searchPath,
      logger,
    });
    return { hostTools, warn };
  }

  it("reports and keeps the effective path of each known tool (all four cases)", async () => {
    const configured = await stub("opt/configured");
    const onPath = await stub("path/configured");
    const discovered = await stub("path/discovered");
    const { hostTools } = paths();
    const report = await hostTools.check([
      { name: "configured", configuredPath: configured },
      { name: "missing", configuredPath: path.join(root, "opt/missing") },
      { name: "discovered", configuredPath: null },
      { name: "nowhere", configuredPath: null },
    ]);
    expect(report).toEqual([
      {
        name: "configured",
        configuredPath: configured,
        configuredPathExists: true,
        discoveredPath: onPath,
      },
      {
        name: "missing",
        configuredPath: path.join(root, "opt/missing"),
        configuredPathExists: false,
        discoveredPath: null,
      },
      {
        name: "discovered",
        configuredPath: null,
        configuredPathExists: null,
        discoveredPath: discovered,
      },
      { name: "nowhere", configuredPath: null, configuredPathExists: null, discoveredPath: null },
    ]);
    expect(hostTools.path("configured")).toBe(configured);
    expect(hostTools.path("missing")).toBeNull();
    expect(hostTools.path("discovered")).toBe(discovered);
    expect(hostTools.path("nowhere")).toBeNull();
    expect(hostTools.path("unknown")).toBeNull();
  });

  it("doesn't fall back to the discovered path when the configured one is missing", async () => {
    await stub("path/tool");
    const { hostTools } = paths();
    await hostTools.check([{ name: "tool", configuredPath: path.join(root, "nope/tool") }]);
    expect(hostTools.path("tool")).toBeNull();
  });

  it("reports a blocked configured path as missing and warns once", async () => {
    const configured = await stub("blocked/tool");
    const { hostTools, warn } = paths([path.join(root, "blocked")]);
    const known = [{ name: "tool", configuredPath: configured }];
    expect(await hostTools.check(known)).toEqual([
      {
        name: "tool",
        configuredPath: configured,
        configuredPathExists: false,
        discoveredPath: null,
      },
    ]);
    expect(hostTools.path("tool")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { hostTool: "tool", path: configured },
      expect.stringContaining("blockedExecPaths"),
    );
    await hostTools.check(known);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never reports a blocked discovered path", async () => {
    await stub("path/tool");
    const { hostTools } = paths([path.join(root, "path")]);
    expect(await hostTools.check([{ name: "tool", configuredPath: null }])).toEqual([
      { name: "tool", configuredPath: null, configuredPathExists: null, discoveredPath: null },
    ]);
    expect(hostTools.path("tool")).toBeNull();
  });

  it("forgets a tool's path when a response removes it or configures another path", async () => {
    const a = await stub("path/a");
    const b = await stub("path/b");
    const { hostTools } = paths();
    await hostTools.check([
      { name: "a", configuredPath: null },
      { name: "b", configuredPath: null },
    ]);
    hostTools.update([
      { name: "a", configuredPath: null },
      { name: "b", configuredPath: null },
    ]);
    expect([hostTools.path("a"), hostTools.path("b")]).toEqual([a, b]);
    hostTools.update([{ name: "b", configuredPath: "/opt/b" }]);
    expect([hostTools.path("a"), hostTools.path("b")]).toEqual([null, null]);
  });
});
