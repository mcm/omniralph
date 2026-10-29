/**
 * The Packages page's copy and pure helpers: the allow-list's validation and save bar
 * changes, and how an install history row reads.
 */
import { PackagePattern } from "@omniralph/shared";
import type { StagedChange, StatusTone } from "@omniralph/ui";
import type { InstallSummary } from "../../../../src/packages/history.js";

export type { InstallSummary };

/** An installed package. */
export interface InstalledPackage {
  name: string;
  version: string;
}

/** `GET /api/packages`. */
export interface InstalledPackages {
  packages: InstalledPackage[];
}

/** `GET /api/packages/history`. */
export interface InstallHistoryList {
  installs: InstallSummary[];
}

export const ALLOW_LIST_DESCRIPTION =
  "Package names or patterns this agent may install, such as @omniralph/*. Installs requested from Fleet follow it too.";
export const INSTALL_SHEET_DESCRIPTION =
  "Only packages that match the allow-list can be installed.";
/** The effect of an empty allow-list, and the Installed card's description then. */
export const NO_PACKAGE_INSTALLABLE = "No package can be installed";
export const PATTERN_INVALID = "Use a package name or a pattern like @scope/*";
export const PACKAGE_NAME_REQUIRED = "Enter a package name.";
export const DEFAULT_INSTALL_VERSION = "latest";

/** The allow-list input's error for `value`, or null when it's a valid pattern. */
export function patternError(value: string): string | null {
  return PackagePattern.safeParse(value.trim()).success ? null : PATTERN_INVALID;
}

/** What a pattern lets in, as the subject of an effect sentence. */
function matching(pattern: string): string {
  return pattern.includes("*") ? `Packages matching ${pattern}` : pattern;
}

/** The save bar's lines for an allow-list edit: one per pattern added or removed. */
export function allowListChanges(saved: string[], draft: string[]): StagedChange[] {
  if (draft.length === 0 && saved.length > 0) {
    return [
      {
        id: "allow-list",
        label: "Allow-list",
        from: saved.join(", "),
        to: "None",
        effect: NO_PACKAGE_INSTALLABLE,
      },
    ];
  }
  const added = draft.filter((pattern) => !saved.includes(pattern));
  const removed = saved.filter((pattern) => !draft.includes(pattern));
  return [
    ...added.map((pattern) => ({
      id: `allow:${pattern}`,
      label: `Allow ${pattern}`,
      effect: `${matching(pattern)} can be installed.`,
    })),
    ...removed.map((pattern) => ({
      id: `remove:${pattern}`,
      label: `Stop allowing ${pattern}`,
      effect: `${matching(pattern)} can't be installed anymore. What's installed stays.`,
    })),
  ];
}

export const FROM_LABELS: Record<InstallSummary["from"], string> = {
  local: "This machine",
  fleet: "Fleet",
};

/** The history row's package: `name@version` (the version installed once it is). */
export function installPackageLabel(install: InstallSummary): string {
  if (install.action === "remove") {
    return install.previousVersion ? `${install.name}@${install.previousVersion}` : install.name;
  }
  return `${install.name}@${install.installedVersion ?? install.version ?? DEFAULT_INSTALL_VERSION}`;
}

/** The history row's outcome and its tone. */
export function installOutcome(install: InstallSummary): { text: string; tone: StatusTone } {
  switch (install.outcome) {
    case null:
      return install.action === "remove"
        ? { text: `Removing ${install.name}…`, tone: "run" }
        : { text: `Installing ${install.name}…`, tone: "run" };
    case "installed":
      return install.installedVersion !== null &&
        install.installedVersion === install.previousVersion
        ? { text: "Already installed", tone: "neutral" }
        : { text: "Installed", tone: "good" };
    case "removed":
      return { text: "Removed", tone: "neutral" };
    case "failed":
      return { text: "Failed", tone: "fail" };
  }
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The history entry the page shows before the agent answered (`optimistic`). */
export function pendingInstall(
  id: string,
  request: { name: string; version: string },
  now = new Date(),
): InstallSummary {
  return {
    id,
    action: "install",
    name: request.name,
    version: request.version,
    installedVersion: null,
    previousVersion: null,
    from: "local",
    startedAt: now.toISOString(),
    finishedAt: null,
    outcome: null,
    error: null,
  };
}

/** The history entry of a removal before the agent answered. */
export function pendingRemoval(
  id: string,
  installed: { name: string; version: string },
  now = new Date(),
): InstallSummary {
  return {
    ...pendingInstall(id, { name: installed.name, version: installed.version }, now),
    action: "remove",
    version: null,
    previousVersion: installed.version,
  };
}
