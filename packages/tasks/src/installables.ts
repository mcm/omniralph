/**
 * Installables: npm packages whose package.json has an `omniralph` field
 * declaring the commands, MCP servers and skills they put on a harness. The
 * harness installs them; the control panel shows and requires them.
 *
 * No `node:path` here: the control panel's client code imports this package.
 * Paths are POSIX, as on every host a harness runs on.
 */
import { z } from "zod";

/** A command or MCP server name. */
export const INSTALLABLE_ITEM_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An npm package name, scoped or not (lowercase, as npm requires of new packages). */
const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const NPM_NAME_MAX_LENGTH = 214;
/** A semver version (semver.org's recommended pattern). */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** An npm package name an installable may have (as `parseInstallablePackage` checks it). */
export const InstallablePackageName = z
  .string()
  .max(NPM_NAME_MAX_LENGTH)
  .regex(NPM_NAME_PATTERN, "Expected a valid npm package name")
  // Never an option to npm.
  .refine((name) => !name.startsWith("-"), "Expected a valid npm package name");

/**
 * The version of an installable to install: an exact semver version or a
 * dist-tag (e.g. `latest`). Nothing npm could read as another package, a URL,
 * a path or an alias (`npm:`), so `<name>@<version>` always names that package.
 */
export const InstallableVersion = z
  .string()
  .max(64)
  .refine(
    (v) => SEMVER_PATTERN.test(v) || /^[a-z][a-z0-9._-]{0,63}$/i.test(v),
    "Expected a semver version or a dist-tag",
  );

/**
 * `path` relative to the package directory and normalized (no `.`, empty or
 * `..` segments), or null when it is empty, absolute, uses backslashes, or
 * leaves the package directory (or names the directory itself).
 */
export function normalizePackagePath(path: string): string | null {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join("/") : null;
}

/** A path inside the package directory, normalized (`./bin/x` becomes `bin/x`). */
const PackagePath = z.string().transform((path, ctx) => {
  const normalized = normalizePackagePath(path);
  if (normalized === null) {
    ctx.addIssue({
      code: "custom",
      message: "Use a relative path that stays inside the package directory",
    });
    return z.NEVER;
  }
  return normalized;
});

const ItemName = z
  .string()
  .regex(
    INSTALLABLE_ITEM_NAME_PATTERN,
    "Use up to 64 lowercase letters, digits, ., _ and -, starting with a letter or digit",
  );

/** An executable the installable provides, run by its absolute path. */
export const InstallableCommand = z.object({
  name: ItemName,
  /** The executable, relative to the package directory. */
  bin: PackagePath,
});
export type InstallableCommand = z.infer<typeof InstallableCommand>;

/** A stdio MCP server the installable provides; agent definitions list it by name. */
export const InstallableMcpServer = z.object({
  name: ItemName,
  /** The server's executable, relative to the package directory. */
  command: PackagePath,
  args: z.array(z.string()).default([]),
});
export type InstallableMcpServer = z.infer<typeof InstallableMcpServer>;

function uniqueNames(field: string) {
  return (items: { name: string }[], ctx: z.RefinementCtx) => {
    const names = new Set<string>();
    items.forEach((item, index) => {
      if (names.has(item.name)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `${field} name ${item.name} is used twice`,
        });
      }
      names.add(item.name);
    });
  };
}

/** The `omniralph` field of an installable's package.json. */
export const InstallableManifest = z.object({
  commands: z.array(InstallableCommand).superRefine(uniqueNames("Command")).default([]),
  mcpServers: z.array(InstallableMcpServer).superRefine(uniqueNames("MCP server")).default([]),
  /** Skill files or directories, relative to the package directory. */
  skills: z.array(PackagePath).default([]),
});
export type InstallableManifest = z.infer<typeof InstallableManifest>;
export type InstallableManifestInput = z.input<typeof InstallableManifest>;

export interface InstallablePackage {
  name: string;
  version: string;
  manifest: InstallableManifest;
}

export type InstallablePackageErrorCode =
  /** Not a JSON object, or no valid npm `name` or semver `version`. */
  | "invalid-package"
  /** No `omniralph` field. */
  | "not-installable"
  /** An `omniralph` field that doesn't match `InstallableManifest`. */
  | "invalid-manifest";

export interface InstallablePackageError {
  code: InstallablePackageErrorCode;
  message: string;
  /** Problems by field path (e.g. `omniralph.commands.1.name`). */
  fieldErrors: Record<string, string>;
}

export type InstallablePackageParse =
  { ok: true; installable: InstallablePackage } | { ok: false; error: InstallablePackageError };

function failure(
  code: InstallablePackageErrorCode,
  fieldErrors: Record<string, string>,
): InstallablePackageParse {
  const details = Object.entries(fieldErrors)
    .map(([field, message]) => `${field}: ${message}`)
    .join("; ");
  const summary = {
    "invalid-package": "Not a valid package.json",
    "not-installable": "Not an installable: package.json has no omniralph field",
    "invalid-manifest": "Invalid omniralph field",
  }[code];
  return {
    ok: false,
    error: { code, message: details ? `${summary} (${details})` : summary, fieldErrors },
  };
}

/** The name, version and manifest of an installable, from its parsed package.json. */
export function parseInstallablePackage(packageJson: unknown): InstallablePackageParse {
  if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
    return failure("invalid-package", { form: "Expected a JSON object" });
  }
  const pkg = packageJson as Record<string, unknown>;
  const packageErrors: Record<string, string> = {};
  const { name, version } = pkg;
  if (
    typeof name !== "string" ||
    name.length > NPM_NAME_MAX_LENGTH ||
    !NPM_NAME_PATTERN.test(name)
  ) {
    packageErrors.name = "Expected a valid npm package name";
  }
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    packageErrors.version = "Expected a semver version";
  }
  if (Object.keys(packageErrors).length > 0) return failure("invalid-package", packageErrors);
  if (pkg.omniralph === undefined) return failure("not-installable", {});

  const parsed = InstallableManifest.safeParse(pkg.omniralph);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[["omniralph", ...issue.path.map(String)].join(".")] ??= issue.message;
    }
    return failure("invalid-manifest", fieldErrors);
  }
  return {
    ok: true,
    installable: { name: name as string, version: version as string, manifest: parsed.data },
  };
}

export interface InstallablePaths {
  /** Absolute executable path by command name. */
  commands: Record<string, string>;
  /** Absolute executable path by MCP server name. */
  mcpServers: Record<string, string>;
  /** Absolute skill paths, in manifest order. */
  skills: string[];
}

/**
 * The absolute paths of a manifest's commands, MCP servers and skills in the
 * installed package at `packageDir` (an absolute path). Throws on a relative
 * `packageDir`, or a path that leaves it (only an unparsed manifest has one).
 */
export function resolveInstallablePaths(
  packageDir: string,
  manifest: InstallableManifest,
): InstallablePaths {
  if (!packageDir.startsWith("/")) {
    throw new Error(`Package directory ${packageDir} is not an absolute path`);
  }
  const root = packageDir.replace(/\/+$/, "");
  const resolve = (path: string) => {
    const normalized = normalizePackagePath(path);
    if (normalized === null) {
      throw new Error(`Path ${path} leaves the package directory ${packageDir}`);
    }
    return `${root}/${normalized}`;
  };
  return {
    commands: Object.fromEntries(manifest.commands.map((c) => [c.name, resolve(c.bin)])),
    mcpServers: Object.fromEntries(manifest.mcpServers.map((s) => [s.name, resolve(s.command)])),
    skills: manifest.skills.map(resolve),
  };
}
