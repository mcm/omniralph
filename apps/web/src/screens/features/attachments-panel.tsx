"use client";

import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  PlainLink,
  Sheet,
  UiProvider,
} from "@omniralph/ui";
import {
  IconDownload,
  IconEye,
  IconFile,
  IconFileTypePdf,
  IconPhoto,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { AttachmentRow } from "@/lib/api/features";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_HINT,
  attachmentProblem,
  formatBytes,
  previewKind,
} from "./feature-status";
import { useDeleteAttachment, useUploadAttachment } from "./mutations";
import { useFeatureAttachments } from "./queries";

export const ATTACHMENTS_TITLE = "Attachments";
export const NO_ATTACHMENTS = "No attachments yet";
export const NO_ATTACHMENTS_EDITABLE = "Drop mockups, design boards or specs here.";
export const NO_ATTACHMENTS_READ_ONLY =
  "Mockups, design boards and specs an admin attaches show here.";
export const ATTACHMENTS_LOAD_FAILED = "Couldn't load the attachments";
export const DROP_FILES = "Drop files to attach them";
export const CHOOSE_FILES = "Choose files";
export const REMOVE_ATTACHMENT = "Remove attachment";

/** The download link of an attachment: its URL, saving the file rather than showing it. */
export function downloadHref(attachment: AttachmentRow): string {
  return `${attachment.url}${attachment.url.includes("?") ? "&" : "?"}download=1`;
}

/**
 * Download links as plain anchors: a file from the API, never a page for the router to
 * prefetch or navigate to.
 */
function FileLinks({ children }: { children: ReactNode }) {
  return <UiProvider linkComponent={PlainLink}>{children}</UiProvider>;
}

function fileIcon(contentType: string) {
  const kind = previewKind(contentType);
  return kind === "image" ? IconPhoto : kind === "pdf" ? IconFileTypePdf : IconFile;
}

/** A file on its way up: shown in the list until the server answers. */
interface Upload {
  id: number;
  file: File;
}

export interface AttachmentsPanelProps {
  featureId: string;
  /** Uploads and removals allowed: an admin, on a feature that isn't archived. */
  editable: boolean;
}

/**
 * A feature's attachments: each with its name, size, a preview (images and PDFs), a download
 * and, for editors, Remove after confirmation. Editors attach files by dropping them on the
 * panel or with Choose files; files the server wouldn't take (type, size) are refused before
 * they're sent, each with its reason. A live query.
 */
export function AttachmentsPanel({ featureId, editable }: AttachmentsPanelProps) {
  const headingId = useId();
  const hintId = useId();
  const list = useFeatureAttachments(featureId);
  const upload = useUploadAttachment(featureId);
  const remove = useDeleteAttachment(featureId);
  const picker = useRef<HTMLInputElement>(null);
  const nextUpload = useRef(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [previewing, setPreviewing] = useState<AttachmentRow | null>(null);
  const [removing, setRemoving] = useState<AttachmentRow | null>(null);

  const attach = (files: readonly File[]) => {
    const refused: string[] = [];
    for (const file of files) {
      const problem = attachmentProblem(file);
      if (problem) {
        refused.push(problem);
        continue;
      }
      const entry = { id: nextUpload.current++, file };
      setUploads((current) => [...current, entry]);
      upload.mutate(file, {
        onSettled: () => setUploads((current) => current.filter((item) => item.id !== entry.id)),
        onError: (error) =>
          setProblems((current) => [...current, `${file.name}: ${error.message}`]),
      });
    }
    setProblems(refused);
  };

  const dropProps = editable
    ? {
        onDragEnter: (event: DragEvent<HTMLElement>) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        },
        onDragOver: (event: DragEvent<HTMLElement>) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          event.preventDefault();
          setDragging(false);
          attach(Array.from(event.dataTransfer.files));
        },
      }
    : {};

  const attachments = list.data?.attachments;

  return (
    <section
      className={["or-feature-files", dragging && "or-feature-files--dragging"]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={headingId}
      {...dropProps}
    >
      <div className="or-feature-files__head">
        <h3 id={headingId} className="or-feature__section-title">
          {ATTACHMENTS_TITLE}
        </h3>
        {editable ? (
          <>
            <Button
              variant="outline"
              size="sm"
              icon={IconUpload}
              aria-describedby={hintId}
              onClick={() => picker.current?.click()}
            >
              {CHOOSE_FILES}
            </Button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              accept={ATTACHMENT_ACCEPT}
              aria-label={CHOOSE_FILES}
              data-testid="attachment-picker"
              onChange={(event) => {
                attach(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </>
        ) : null}
      </div>
      {editable ? (
        <p id={hintId} className="or-feature__hint">
          {dragging ? DROP_FILES : `Drop files here or choose them. ${ATTACHMENT_HINT}`}
        </p>
      ) : null}

      {problems.length > 0 ? (
        <ul className="or-feature__error or-feature-files__problems" role="alert">
          {problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      ) : null}

      {list.isError && !attachments ? (
        <EmptyState
          headingLevel={4}
          title={ATTACHMENTS_LOAD_FAILED}
          description={list.error.message}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      ) : !attachments ? (
        <div role="status" data-testid="attachments-skeleton">
          <span className="or-sr-only">Loading attachments…</span>
          <div aria-hidden="true">
            {[0, 1].map((index) => (
              <div key={index} className="or-feature-skeleton__row" />
            ))}
          </div>
        </div>
      ) : attachments.length === 0 && uploads.length === 0 ? (
        <EmptyState
          headingLevel={4}
          title={NO_ATTACHMENTS}
          description={editable ? NO_ATTACHMENTS_EDITABLE : NO_ATTACHMENTS_READ_ONLY}
        />
      ) : (
        <ul className="or-feature-files__list" aria-label={ATTACHMENTS_TITLE}>
          {attachments.map((attachment) => {
            const Icon = fileIcon(attachment.contentType);
            const preview = previewKind(attachment.contentType);
            return (
              <li key={attachment.id} className="or-feature-file">
                {preview === "image" ? (
                  // Served by the panel after an access check, never optimized by Next.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="or-feature-file__thumb" src={attachment.url} alt="" />
                ) : (
                  <span className="or-feature-file__icon" aria-hidden="true">
                    <Icon size={18} stroke={1.75} />
                  </span>
                )}
                <span className="or-feature-file__text">
                  <span className="or-feature-file__name">{attachment.fileName}</span>
                  <span className="or-feature-file__size">{formatBytes(attachment.size)}</span>
                </span>
                <span className="or-feature-file__actions">
                  {preview ? (
                    <IconButton
                      size="sm"
                      icon={IconEye}
                      label={`Preview ${attachment.fileName}`}
                      onClick={() => setPreviewing(attachment)}
                    />
                  ) : null}
                  <FileLinks>
                    <IconButton
                      size="sm"
                      icon={IconDownload}
                      label={`Download ${attachment.fileName}`}
                      href={downloadHref(attachment)}
                      download={attachment.fileName}
                    />
                  </FileLinks>
                  {editable ? (
                    <IconButton
                      size="sm"
                      icon={IconTrash}
                      label={`Remove ${attachment.fileName}`}
                      onClick={() => setRemoving(attachment)}
                    />
                  ) : null}
                </span>
              </li>
            );
          })}
          {uploads.map((entry) => (
            <li key={`upload-${entry.id}`} className="or-feature-file or-feature-file--uploading">
              <span className="or-feature-file__icon" aria-hidden="true">
                <IconUpload size={18} stroke={1.75} />
              </span>
              <span className="or-feature-file__text">
                <span className="or-feature-file__name">{entry.file.name}</span>
                <span className="or-feature-file__size" role="status">
                  Uploading… {formatBytes(entry.file.size)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <AttachmentPreview attachment={previewing} onClose={() => setPreviewing(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={REMOVE_ATTACHMENT}
        description={
          removing
            ? `Remove ${removing.fileName} from this feature? Runs on its epics stop getting it.`
            : ""
        }
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing);
        }}
      />
    </section>
  );
}

/** An image or PDF attachment, shown in a sheet with its name, size and a download. */
function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: AttachmentRow | null;
  onClose: () => void;
}) {
  const kind = attachment ? previewKind(attachment.contentType) : null;
  return (
    <Sheet
      title={attachment?.fileName ?? "Preview"}
      description={attachment ? formatBytes(attachment.size) : undefined}
      open={attachment !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        attachment ? (
          <>
            <FileLinks>
              <Button
                variant="outline"
                icon={IconDownload}
                href={downloadHref(attachment)}
                download={attachment.fileName}
              >
                Download
              </Button>
            </FileLinks>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </>
        ) : null
      }
    >
      {attachment && kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="or-feature-preview__image" src={attachment.url} alt={attachment.fileName} />
      ) : attachment && kind === "pdf" ? (
        <iframe
          className="or-feature-preview__pdf"
          src={attachment.url}
          title={attachment.fileName}
        />
      ) : null}
    </Sheet>
  );
}
