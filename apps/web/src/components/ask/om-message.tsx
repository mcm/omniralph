"use client";

import { FileBadge, Glyph, IssueBadge, Markdown, MetaBadge } from "@omniralph/ui";
import type { AskMessageView } from "@/lib/api/ask";
import { runHref } from "@/lib/runs/hrefs";
import { omRunMeta } from "./format";
import "./ask-messages.css";

export interface OmMessageProps {
  message: Pick<AskMessageView, "markdown" | "status" | "run" | "files" | "workItems">;
  /** What Om is doing while it streams (a `status` event, e.g. "Looking at runs"). */
  status?: string | null;
}

/**
 * An Om message: the "Om" line (with read-only, read N files and 41s badges for an answer
 * from an ask run), the answer as Markdown, then a badge row with each cited file and each
 * work item it mentions (linked to the item's run when it has one). While it streams, the
 * text grows as it arrives and `status` says what Om is doing.
 */
export function OmMessage({ message, status }: OmMessageProps) {
  const meta = omRunMeta(message.run);
  const streaming = message.status === "streaming";
  const text = message.markdown.trim();
  const hasRefs = message.files.length > 0 || message.workItems.length > 0;
  return (
    <article className="or-ask-om" aria-label="Om" aria-busy={streaming || undefined}>
      <p className="or-ask-om__who">
        <Glyph size={16} className="or-ask-om__glyph" />
        <span className="or-ask-om__name">Om</span>
        {meta?.map((part) => (
          <MetaBadge key={part} className="or-ask-om__meta" text={part} />
        ))}
      </p>
      {text ? <Markdown className="or-ask-om__body">{message.markdown}</Markdown> : null}
      {streaming && status ? (
        <p className="or-ask-om__status" role="status">
          {status}
        </p>
      ) : null}
      {hasRefs ? (
        <div className="or-ask-om__refs">
          {message.files.map((file) => (
            <FileBadge
              key={`${file.path}:${file.startLine ?? ""}:${file.endLine ?? ""}`}
              path={file.path}
              startLine={file.startLine}
              endLine={file.endLine}
              href={file.url ?? undefined}
            />
          ))}
          {message.workItems.map((item) => (
            <IssueBadge
              key={item.identifier}
              tracker={item.tracker}
              id={item.identifier}
              href={item.runId ? runHref(item.runId) : item.url}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}
