"use client";

import {
  IconBuilding,
  IconFile,
  IconGitBranch,
  IconGitMerge,
  IconServer,
  type TablerIcon,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Tooltip } from "../actions/tooltip.js";
import { Glyph } from "../brand/glyph.js";
import { RefBadge, type BadgeLinkProps } from "./badge.js";
import { BrandMark } from "./brand-mark.js";

const ICON_SIZE = 14;

/** A Tabler icon that carries meaning: `role="img"` named after the badge kind. */
function KindIcon({ icon: Icon, label }: { icon: TablerIcon; label: string }) {
  return (
    <Icon
      className="or-ref__icon"
      size={ICON_SIZE}
      stroke={1.75}
      role="img"
      aria-label={label}
      focusable="false"
    />
  );
}

export interface OrgBadgeProps extends BadgeLinkProps {
  name: string;
}

/** An organization: building icon + name. */
export function OrgBadge({ name, ...rest }: OrgBadgeProps) {
  return (
    <RefBadge
      {...rest}
      kind="org"
      title="Organization"
      icon={<KindIcon icon={IconBuilding} label="Organization" />}
      text={name}
    />
  );
}

/** Code hosts a repository can live on. */
export type CodeHost = "github" | "gitlab";

export interface RepoBadgeProps extends BadgeLinkProps {
  host: CodeHost;
  /** The repository name, e.g. `acme/web`. */
  name: string;
  /** Primary text color and weight, for the subject of a row or page. */
  strong?: boolean;
}

/** A repository: code-host mark + name. */
export function RepoBadge({ host, name, strong, ...rest }: RepoBadgeProps) {
  return (
    <RefBadge
      {...rest}
      kind="repo"
      strong={strong}
      icon={<BrandMark brand={host} size={ICON_SIZE} className="or-ref__icon" />}
      text={name}
    />
  );
}

/** Trackers an issue can come from: Linear, or Omniralph's own backlog. */
export type IssueTracker = "linear" | "omniralph";

export interface IssueBadgeProps extends BadgeLinkProps {
  tracker: IssueTracker;
  /** The issue identifier, e.g. `TOOL-590`. */
  id: string;
}

/** An issue: tracker mark + mono ID. */
export function IssueBadge({ tracker, id, ...rest }: IssueBadgeProps) {
  return (
    <RefBadge
      {...rest}
      kind="issue"
      mono
      icon={
        tracker === "omniralph" ? (
          <Glyph size={15} label="Omniralph" className="or-ref__icon" />
        ) : (
          <BrandMark brand="linear" size={ICON_SIZE} className="or-ref__icon" />
        )
      }
      text={id}
    />
  );
}

export interface BranchBadgeProps extends BadgeLinkProps {
  name: string;
}

/** A git branch: branch icon + mono name. */
export function BranchBadge({ name, ...rest }: BranchBadgeProps) {
  return (
    <RefBadge
      {...rest}
      kind="branch"
      mono
      icon={<KindIcon icon={IconGitBranch} label="Branch" />}
      text={name}
    />
  );
}

export interface ChangeBadgeProps extends BadgeLinkProps {
  /** GitLab merge requests read `!<n>`, GitHub pull requests `#<n>`. */
  host: CodeHost;
  number: number;
}

/** A merge request (GitLab, `!12`) or pull request (GitHub, `#12`). */
export function ChangeBadge({ host, number, ...rest }: ChangeBadgeProps) {
  const gitlab = host === "gitlab";
  return (
    <RefBadge
      {...rest}
      kind="change"
      mono
      icon={<KindIcon icon={IconGitMerge} label={gitlab ? "Merge request" : "Pull request"} />}
      text={`${gitlab ? "!" : "#"}${number}`}
    />
  );
}

export interface AgentBadgeProps extends BadgeLinkProps {
  name: string;
}

/** An agent: server icon + name. */
export function AgentBadge({ name, ...rest }: AgentBadgeProps) {
  return (
    <RefBadge
      {...rest}
      kind="agent"
      icon={<KindIcon icon={IconServer} label="Agent" />}
      text={name}
    />
  );
}

export interface MetaBadgeProps extends BadgeLinkProps {
  /** An optional decorative Tabler icon. */
  icon?: TablerIcon;
  /**
   * A leading mark in place of `icon`, e.g. the tracker's
   * `<BrandMark brand="linear" className="or-ref__icon" />`.
   */
  mark?: ReactNode;
  text: string;
  mono?: boolean;
}

/** Any other fact shown as a badge (a model, a duration, a count). */
export function MetaBadge({ icon: Icon, mark, text, mono, ...rest }: MetaBadgeProps) {
  return (
    <RefBadge
      {...rest}
      kind="meta"
      mono={mono}
      icon={
        mark ? (
          mark
        ) : Icon ? (
          <Icon className="or-ref__icon" size={ICON_SIZE} stroke={1.75} aria-hidden="true" />
        ) : undefined
      }
      text={text}
    />
  );
}

/** T-shirt sizes. */
export type TShirtSize = "XS" | "S" | "M" | "L" | "XL";

export const T_SHIRT_SIZES: readonly TShirtSize[] = ["XS", "S", "M", "L", "XL"];

export interface SizeBadgeProps {
  size: TShirtSize;
  className?: string;
}

/** A size: its mono letters, named and tooltipped "Size S" etc. */
export function SizeBadge({ size, className }: SizeBadgeProps) {
  const label = `Size ${size}`;
  return (
    <Tooltip content={label}>
      <span
        className={className ? `or-size or-mono ${className}` : "or-size or-mono"}
        role="img"
        aria-label={label}
        data-or-badge="size"
      >
        {size}
      </span>
    </Tooltip>
  );
}

export interface FileBadgeProps extends BadgeLinkProps {
  /** The file's path in its repo, e.g. `src/app/page.tsx`. */
  path: string;
  /** The first and last line cited, when the reference names lines. */
  startLine?: number | null;
  endLine?: number | null;
}

/** The last segment of a path: what a file badge shows. */
function fileName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/**
 * A file's full path and lines, as its badge's tooltip and accessible name:
 * "src/app/page.tsx · lines 12–20", "src/app/page.tsx · line 12", "src/app/page.tsx".
 */
export function fileBadgeLabel(
  path: string,
  startLine?: number | null,
  endLine?: number | null,
): string {
  if (startLine == null) return path;
  if (endLine == null || endLine === startLine) return `${path} · line ${startLine}`;
  return `${path} · lines ${startLine}–${endLine}`;
}

/**
 * A file in a repo: file icon + its name in mono. The full path and lines are its tooltip
 * and what assistive tech reads; with `href` it links to the file on the code host.
 */
export function FileBadge({ path, startLine, endLine, ...rest }: FileBadgeProps) {
  const label = fileBadgeLabel(path, startLine, endLine);
  return (
    <Tooltip content={label}>
      <RefBadge
        {...rest}
        kind="file"
        mono
        icon={
          <IconFile className="or-ref__icon" size={ICON_SIZE} stroke={1.75} aria-hidden="true" />
        }
        text={fileName(path)}
        srText={label}
      />
    </Tooltip>
  );
}
