import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostToolPaths, findOnPath, isExecutableFile } from "./host-tools.js";
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

describe("HostToolPaths", () => {
  function paths(
    configured: Record<string, string> = {},
    blockedExecPaths: string[] = [],
    searchPath = path.join(root, "path"),
  ) {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, "warn");
    const settings = { hostTools: configured };
    const hostTools = new HostToolPaths({
      config: { blockedExecPaths },
      configured: () => settings.hostTools,
      searchPath: () => searchPath,
      logger,
    });
    return { hostTools, warn, settings };
  }

  it("checks every configured and required name, by name, and keeps their paths", async () => {
    const configured = await stub("opt/configured");
    await stub("path/configured");
    const discovered = await stub("path/discovered");
    const { hostTools } = paths({
      configured,
      missing: path.join(root, "opt/missing"),
    });
    const report = await hostTools.check(["nowhere", "discovered", "configured"]);
    expect(report).toEqual([
      { name: "configured", path: configured, source: "configured", problem: null },
      { name: "discovered", path: discovered, source: "discovered", problem: null },
      { name: "missing", path: null, source: null, problem: "missing" },
      { name: "nowhere", path: null, source: null, problem: null },
    ]);
    expect(hostTools.path("configured")).toBe(configured);
    expect(hostTools.path("missing")).toBeNull();
    expect(hostTools.path("discovered")).toBe(discovered);
    expect(hostTools.path("nowhere")).toBeNull();
    expect(hostTools.path("unknown")).toBeNull();
  });

  it("checks the configured tools when nothing is required", async () => {
    const configured = await stub("opt/tool");
    const { hostTools } = paths({ tool: configured });
    expect(await hostTools.check([])).toEqual([
      { name: "tool", path: configured, source: "configured", problem: null },
    ]);
    expect(await paths().hostTools.check([])).toEqual([]);
  });

  it("uses a configured path over a match on PATH", async () => {
    const configured = await stub("opt/tool");
    await stub("path/tool");
    const { hostTools } = paths({ tool: configured });
    expect(await hostTools.check(["tool"])).toEqual([
      { name: "tool", path: configured, source: "configured", problem: null },
    ]);
  });

  it("doesn't fall back to PATH when the configured path is missing", async () => {
    await stub("path/tool");
    const { hostTools } = paths({ tool: path.join(root, "nope/tool") });
    expect(await hostTools.check(["tool"])).toEqual([
      { name: "tool", path: null, source: null, problem: "missing" },
    ]);
    expect(hostTools.path("tool")).toBeNull();
  });

  it("reports a configured path that isn't an executable file as not executable", async () => {
    await stub("path/tool");
    const data = await stub("opt/data", 0o644);
    await mkdir(path.join(root, "opt/dir"));
    const { hostTools } = paths({ data, dir: path.join(root, "opt/dir") });
    expect(await hostTools.check(["data", "dir"])).toEqual([
      { name: "data", path: null, source: null, problem: "not_executable" },
      { name: "dir", path: null, source: null, problem: "not_executable" },
    ]);
    expect(hostTools.path("data")).toBeNull();
  });

  it("reports a blocked configured path as blocked, without fallback, and warns once", async () => {
    const configured = await stub("blocked/tool");
    await stub("path/tool");
    const { hostTools, warn } = paths({ tool: configured }, [path.join(root, "blocked")]);
    expect(await hostTools.check([])).toEqual([
      { name: "tool", path: null, source: null, problem: "blocked" },
    ]);
    expect(hostTools.path("tool")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { hostTool: "tool", path: configured },
      expect.stringContaining("blockedExecPaths"),
    );
    await hostTools.check([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never reports a blocked discovered path", async () => {
    await stub("path/tool");
    const { hostTools } = paths({}, [path.join(root, "path")]);
    expect(await hostTools.check(["tool"])).toEqual([
      { name: "tool", path: null, source: null, problem: null },
    ]);
    expect(hostTools.path("tool")).toBeNull();
  });

  it("has no path for a tool whose configured path changed until it's checked again", async () => {
    const discovered = await stub("path/tool");
    const configured = await stub("opt/tool");
    const { hostTools, settings } = paths();
    await hostTools.check(["tool"]);
    expect(hostTools.path("tool")).toBe(discovered);
    settings.hostTools = { tool: configured };
    expect(hostTools.path("tool")).toBeNull();
    await hostTools.check(["tool"]);
    expect(hostTools.path("tool")).toBe(configured);
    settings.hostTools = {};
    expect(hostTools.path("tool")).toBeNull();
    // A tool no longer configured nor required is no longer checked.
    expect(await hostTools.check([])).toEqual([]);
    expect(hostTools.path("tool")).toBeNull();
  });
});
