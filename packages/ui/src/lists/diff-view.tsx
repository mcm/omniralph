"use client";

import { IconChevronRight } from "@tabler/icons-react";
import { useId, useState, type ReactNode } from "react";
import { TextLink } from "../actions/text-link.js";

/** One changed file of a diff. */
export interface DiffFile {
  path: string;
  /** The path before a rename; shown before `path` when set. */
  previousPath?: string | null;
  additions: number;
  deletions: number;
  /** Unified diff hunks (`@@ … @@` and the lines after); null when there's nothing to show. */
  patch: string | null;
  /** The patch was cut short or left out for its size. */
  truncated?: boolean;
}

export interface DiffViewProps {
  files: readonly DiffFile[];
  /** More files changed than are listed. */
  truncated?: boolean;
  /** The full diff on the code host, linked from every "too large" notice. */
  url?: string;
  /** The link's text. Defaults to "Open the commit". */
  urlLabel?: ReactNode;
  /** Names the list of files. Defaults to "Diff". */
  "aria-label"?: string;
  className?: string;
}

export const DIFF_TOO_LARGE = "This diff is too large to show in full.";

type LineKind = "add" | "del" | "hunk" | "meta" | "ctx";

/** How a unified diff line reads: added, removed, a hunk header, a `\ No newline` note or context. */
export function diffLineKind(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("\\")) return "meta";
  return "ctx";
}

function TooLarge({ url, urlLabel }: Pick<DiffViewProps, "url" | "urlLabel">) {
  return (
    <p className="or-diff__notice">
      {DIFF_TOO_LARGE}
      {url ? (
        <>
          {" "}
          <TextLink href={url} target="_blank" rel="noreferrer">
            {urlLabel ?? "Open the commit"}
          </TextLink>
        </>
      ) : null}
    </p>
  );
}

function FileSection({
  file,
  url,
  urlLabel,
}: {
  file: DiffFile;
  url?: string;
  urlLabel?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const lines = file.patch === null ? [] : file.patch.replace(/\n$/, "").split("\n");
  return (
    <li className="or-diff__file">
      <div className="or-diff__header">
        <button
          type="button"
          className="or-diff__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <IconChevronRight className="or-diff__chevron" size={14} stroke={2} aria-hidden="true" />
          <span className="or-diff__path or-mono">
            {file.previousPath ? (
              <>
                <span className="or-diff__previous">{file.previousPath}</span>
                {" → "}
              </>
            ) : null}
            {file.path}
          </span>
          <span className="or-diff__stats or-mono">
            <span className="or-diff__stat--add">+{file.additions}</span>{" "}
            <span className="or-diff__stat--del">−{file.deletions}</span>
          </span>
        </button>
      </div>
      <div id={bodyId} className="or-diff__body" hidden={!open}>
        {lines.length > 0 ? (
          <pre className="or-diff__lines or-mono">
            <code>
              {lines.map((line, index) => (
                <span key={index} className={`or-diff__line or-diff__line--${diffLineKind(line)}`}>
                  {line || " "}
                </span>
              ))}
            </code>
          </pre>
        ) : null}
        {file.truncated ? (
          <TooLarge url={url} urlLabel={urlLabel} />
        ) : lines.length === 0 ? (
          <p className="or-diff__notice">No line changes to show.</p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * A commit's changes, one section per file: a header with the path (after the previous
 * path when renamed), "+{additions} −{deletions}" and a collapse toggle, then the unified
 * lines, added in mint and removed in coral. A file or a diff cut short says so, with a
 * link to the full diff on the code host.
 */
export function DiffView({
  files,
  truncated,
  url,
  urlLabel,
  "aria-label": label = "Diff",
  className,
}: DiffViewProps) {
  return (
    <div className={["or-diff", className].filter(Boolean).join(" ")}>
      {files.length > 0 ? (
        <ul className="or-diff__files" aria-label={label}>
          {files.map((file, index) => (
            <FileSection key={`${file.path}:${index}`} file={file} url={url} urlLabel={urlLabel} />
          ))}
        </ul>
      ) : (
        <p className="or-diff__notice">No files changed.</p>
      )}
      {truncated ? <TooLarge url={url} urlLabel={urlLabel} /> : null}
    </div>
  );
}
