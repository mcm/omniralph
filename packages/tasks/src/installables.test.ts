import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  InstallableManifest,
  normalizePackagePath,
  parseInstallableMcpServerRef,
  parseInstallablePackage,
  resolveInstallablePaths,
} from "./index.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`./test/fixtures/installables/${name}/package.json`, import.meta.url),
      "utf8",
    ),
  );
}

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

describe("parseInstallablePackage fixtures", () => {
  it("parses a package with commands, MCP servers and skills", () => {
    expect(parseInstallablePackage(fixture("full"))).toEqual({
      ok: true,
      installable: {
        name: "@omniralph/test-full",
        version: "1.2.3",
        manifest: {
          commands: [
            { name: "graph", bin: "bin/graph.js" },
            { name: "graph-index", bin: "bin/index.js" },
          ],
          mcpServers: [
            { name: "code-graph", command: "bin/mcp.js", args: ["--stdio"] },
            { name: "code-graph.lite", command: "bin/mcp.js", args: [] },
          ],
          skills: ["skills/graph", "skills/query.md"],
        },
      },
    });
  });

  it("parses a package with only commands", () => {
    expect(parseInstallablePackage(fixture("commands-only"))).toEqual({
      ok: true,
      installable: {
        name: "omniralph-test-commands",
        version: "0.1.0-beta.1",
        manifest: { commands: [{ name: "sast", bin: "dist/sast.js" }], mcpServers: [], skills: [] },
      },
    });
  });

  it("rejects a package without an omniralph field as not an installable", () => {
    const result = parseInstallablePackage(fixture("not-installable"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not-installable");
    expect(result.error.message).toMatch(/not an installable/i);
  });

  it("rejects a bin that escapes the package", () => {
    const result = parseInstallablePackage(fixture("escaping-bin"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-manifest");
    expect(Object.keys(result.error.fieldErrors)).toEqual(["omniralph.commands.0.bin"]);
  });

  it("rejects duplicate command names, naming the duplicate", () => {
    const result = parseInstallablePackage(fixture("duplicate-commands"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-manifest");
    expect(result.error.fieldErrors).toEqual({
      "omniralph.commands.1.name": "Command name graph is used twice",
    });
    expect(result.error.message).toContain("graph");
  });
});

describe("parseInstallablePackage", () => {
  const omniralph = { commands: [{ name: "x", bin: "x.js" }] };

  it("rejects what isn't a package.json object", () => {
    for (const input of [null, "pkg", [], 3]) {
      const result = parseInstallablePackage(input);
      expect(result.ok ? null : result.error.code).toBe("invalid-package");
    }
  });

  it("requires a valid npm name and semver version", () => {
    for (const [pkg, fields] of [
      [{ version: "1.0.0", omniralph }, ["name"]],
      [{ name: "Upper", version: "1.0.0", omniralph }, ["name"]],
      [{ name: "@scope/", version: "1.0.0", omniralph }, ["name"]],
      [{ name: "-x", version: "1.0.0", omniralph }, ["name"]],
      [{ name: "a".repeat(215), version: "1.0.0", omniralph }, ["name"]],
      [{ name: "ok", version: "1.0", omniralph }, ["version"]],
      [{ name: "ok", version: "v1.0.0", omniralph }, ["version"]],
      [{ name: "ok", version: 1, omniralph }, ["version"]],
    ] as const) {
      const result = parseInstallablePackage(pkg);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("invalid-package");
      expect(Object.keys(result.error.fieldErrors)).toEqual(fields);
    }
  });

  it("accepts scoped names and an empty manifest", () => {
    const result = parseInstallablePackage({
      name: "@omniralph/code-graph",
      version: "2.0.0+build.5",
      omniralph: {},
    });
    expect(result).toEqual({
      ok: true,
      installable: {
        name: "@omniralph/code-graph",
        version: "2.0.0+build.5",
        manifest: { commands: [], mcpServers: [], skills: [] },
      },
    });
  });

  it("rejects an omniralph field that isn't an object", () => {
    const result = parseInstallablePackage({ name: "ok", version: "1.0.0", omniralph: [] });
    expect(result.ok ? null : result.error.code).toBe("invalid-manifest");
  });
});

describe("InstallableManifest", () => {
  it("checks names", () => {
    for (const name of ["a", "0", "code-graph", "a.b_c-d", "a".repeat(64)]) {
      expect(InstallableManifest.safeParse({ commands: [{ name, bin: "x" }] }).success).toBe(true);
    }
    for (const name of ["", "A", "-a", ".a", "a b", "a/b", "a".repeat(65)]) {
      expect(
        issues(InstallableManifest.safeParse({ mcpServers: [{ name, command: "x" }] })),
      ).toEqual(["mcpServers.0.name"]);
    }
  });

  it("rejects duplicate MCP server names, naming the duplicate, but allows a command of the same name", () => {
    const result = InstallableManifest.safeParse({
      commands: [{ name: "graph", bin: "a" }],
      mcpServers: [
        { name: "graph", command: "a" },
        { name: "graph", command: "b" },
      ],
    });
    expect(issues(result)).toEqual(["mcpServers.1.name"]);
    expect(result.error?.issues[0]?.message).toBe("MCP server name graph is used twice");
  });

  it("rejects paths that aren't inside the package", () => {
    for (const path of ["", "/usr/bin/x", "..", "../x", "a/../../x", ".", "./", "a\\b"]) {
      expect(
        issues(
          InstallableManifest.safeParse({
            commands: [{ name: "c", bin: path }],
            mcpServers: [{ name: "m", command: path }],
            skills: [path],
          }),
        ),
      ).toEqual(["commands.0.bin", "mcpServers.0.command", "skills.0"]);
    }
  });
});

describe("parseInstallableMcpServerRef", () => {
  it("splits <package>:<server>", () => {
    expect(parseInstallableMcpServerRef("@omniralph/code-graph:graph")).toEqual({
      installable: "@omniralph/code-graph",
      server: "graph",
    });
    expect(parseInstallableMcpServerRef("sast:scan.v2")).toEqual({
      installable: "sast",
      server: "scan.v2",
    });
  });

  it("is null for a configured MCP server's name or an invalid reference", () => {
    for (const entry of [
      "github",
      ":graph",
      "pkg:",
      "Pkg:graph",
      "-pkg:graph",
      "pkg:Graph",
      "a:b:c",
    ]) {
      expect(parseInstallableMcpServerRef(entry), entry).toBeNull();
    }
  });
});

describe("normalizePackagePath", () => {
  it("normalizes paths inside the package", () => {
    expect(normalizePackagePath("./bin//x.js")).toBe("bin/x.js");
    expect(normalizePackagePath("a/../b/")).toBe("b");
    expect(normalizePackagePath("../x")).toBeNull();
  });
});

describe("resolveInstallablePaths", () => {
  it("returns absolute paths inside the package directory", () => {
    const result = parseInstallablePackage(fixture("full"));
    if (!result.ok) throw new Error(result.error.message);
    const dir = "/data/installables/node_modules/@omniralph/test-full";
    const paths = resolveInstallablePaths(`${dir}/`, result.installable.manifest);
    expect(paths).toEqual({
      commands: { graph: `${dir}/bin/graph.js`, "graph-index": `${dir}/bin/index.js` },
      mcpServers: { "code-graph": `${dir}/bin/mcp.js`, "code-graph.lite": `${dir}/bin/mcp.js` },
      skills: [`${dir}/skills/graph`, `${dir}/skills/query.md`],
    });
    for (const path of [
      ...Object.values(paths.commands),
      ...Object.values(paths.mcpServers),
      ...paths.skills,
    ]) {
      expect(path.startsWith(`${dir}/`)).toBe(true);
    }
  });

  it("refuses a relative package directory or an escaping path", () => {
    const manifest = { commands: [{ name: "x", bin: "x" }], mcpServers: [], skills: [] };
    expect(() => resolveInstallablePaths("pkg", manifest)).toThrow(/absolute/);
    expect(() =>
      resolveInstallablePaths("/pkg", { ...manifest, commands: [{ name: "x", bin: "../x" }] }),
    ).toThrow(/leaves/);
  });
});
