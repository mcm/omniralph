import "server-only";
import { randomUUID } from "node:crypto";
import {
  deleteAttachment,
  getAttachment,
  insertAttachment,
  listAttachments,
  type Attachment,
  type AttachmentOwner,
  type Database,
} from "@omniralph/db";
import { NextResponse } from "next/server";
import {
  ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  type AttachmentContentType,
  type AttachmentList,
  type AttachmentRow,
  type UploadedAttachment,
} from "@/lib/api/features";
import { ApiRouteError } from "@/lib/api/handler";
import { getObjectStorage, type ObjectStorage } from "./storage";

/**
 * Attachments of features and work items: the `/api/ui/**` handlers' uploads, lists,
 * downloads and deletes. The file goes to object storage under a key of its own
 * (`attachments/<organization>/<attachment>`), its metadata to the `attachments` table.
 */

export const ATTACHMENT_NOT_FOUND_MESSAGE = "That attachment doesn't exist.";
export const STORAGE_NOT_CONFIGURED_MESSAGE =
  "Attachments aren't set up on this Omniralph. Ask whoever runs it to configure object storage.";
export const NO_FILE_MESSAGE = "Choose a file to upload.";
export const TOO_LARGE_MESSAGE = `Files can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
export const DISALLOWED_TYPE_MESSAGE =
  "That type of file can't be attached. Attach images, PDFs, or text, Markdown, CSV or JSON files.";
const STORAGE_FAILED_MESSAGE = "Storing the file failed. Try again in a moment.";

/** Room for the multipart envelope around the file in an upload's body. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const FILE_NAME_MAX_LENGTH = 255;

export interface AttachmentDeps {
  db: Database;
  /** Default: the configured bucket (`getObjectStorage`). */
  storage?: ObjectStorage | null;
}

function storageOf(deps: AttachmentDeps): ObjectStorage {
  const storage = deps.storage === undefined ? getObjectStorage() : deps.storage;
  if (!storage) throw new ApiRouteError(503, STORAGE_NOT_CONFIGURED_MESSAGE, "storage_off");
  return storage;
}

/** The storage key of an attachment. */
export function attachmentStorageKey(organizationId: string, attachmentId: string): string {
  return `attachments/${organizationId}/${attachmentId}`;
}

/** Where an attachment's file is downloaded from. */
function attachmentUrl(attachment: Attachment): string {
  return `/api/ui/attachments/${attachment.id}?organization=${attachment.organizationId}`;
}

export function attachmentRow(attachment: Attachment): AttachmentRow {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    size: attachment.size,
    url: attachmentUrl(attachment),
    createdAt: attachment.createdAt.toISOString(),
  };
}

/** A file name safe to keep and to send back: no path, no control characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return cleaned.slice(0, FILE_NAME_MAX_LENGTH) || "attachment";
}

/**
 * The attachment type of a file: its declared type when it is one we take, else (no type,
 * or a generic one) the type its extension names. Null when it isn't a type we take.
 */
export function attachmentContentType(
  fileName: string,
  declared: string,
): AttachmentContentType | null {
  const type = declared.split(";")[0]!.trim().toLowerCase();
  if (type in ATTACHMENT_TYPES) return type as AttachmentContentType;
  if (type && type !== "application/octet-stream") return null;
  const extension = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0];
  if (!extension) return null;
  const found = Object.entries(ATTACHMENT_TYPES).find(([, extensions]) =>
    (extensions as readonly string[]).includes(extension),
  );
  return (found?.[0] as AttachmentContentType | undefined) ?? null;
}

const tooLarge = () => new ApiRouteError(413, TOO_LARGE_MESSAGE, "too_large");

/**
 * The file of a multipart upload (field `file`), checked: 413 when it (or the whole body)
 * is over the size limit, 400 when there is no file or it isn't a type we take.
 */
export async function readUpload(request: Request): Promise<{
  fileName: string;
  contentType: AttachmentContentType;
  bytes: Uint8Array<ArrayBuffer>;
}> {
  const length = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw tooLarge();
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiRouteError(400, NO_FILE_MESSAGE, "no_file");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiRouteError(400, NO_FILE_MESSAGE, "no_file");
  if (file.size > MAX_ATTACHMENT_BYTES) throw tooLarge();
  const fileName = cleanFileName(file.name);
  const contentType = attachmentContentType(fileName, file.type);
  if (!contentType) throw new ApiRouteError(400, DISALLOWED_TYPE_MESSAGE, "disallowed_type");
  return { fileName, contentType, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** The owner's attachments. */
export async function loadAttachments(
  db: Database,
  owner: AttachmentOwner,
): Promise<AttachmentList> {
  return { attachments: (await listAttachments(db, owner)).map(attachmentRow) };
}

/**
 * Stores an upload's file, then records it for `owner`; a file whose record fails is
 * deleted again. Answers 201 with the attachment.
 */
export async function uploadAttachment(
  deps: AttachmentDeps,
  owner: AttachmentOwner,
  request: Request,
  createdBy: string | null,
): Promise<Response> {
  const storage = storageOf(deps);
  const upload = await readUpload(request);
  const id = randomUUID();
  const storageKey = attachmentStorageKey(owner.organizationId, id);
  try {
    await storage.put(storageKey, upload.bytes, upload.contentType);
  } catch (error) {
    console.error(`Storing attachment ${storageKey} failed`, error);
    throw new ApiRouteError(502, STORAGE_FAILED_MESSAGE, "storage_failed");
  }
  let attachment: Attachment;
  try {
    attachment = await insertAttachment(deps.db, {
      id,
      owner,
      fileName: upload.fileName,
      contentType: upload.contentType,
      size: upload.bytes.byteLength,
      storageKey,
      createdBy,
    });
  } catch (error) {
    await storage
      .delete(storageKey)
      .catch((cleanup) => console.error(`Deleting orphaned file ${storageKey} failed`, cleanup));
    throw error;
  }
  const body: UploadedAttachment = { ok: true, attachment: attachmentRow(attachment) };
  return NextResponse.json(body, { status: 201 });
}

/** Images and PDFs open in the browser; other files download. */
const SHOWN_INLINE = /^(image\/|application\/pdf$)/;

/** `Content-Disposition` with the file name, ASCII-safe and as UTF-8 (RFC 6266). */
function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * The organization's attachment's file: shown in the browser when it's an image or a PDF
 * (unless `download`), else downloaded. 404 when there is no such attachment or file.
 */
export async function downloadAttachment(
  deps: AttachmentDeps,
  organizationId: string,
  attachmentId: string,
  download: boolean,
): Promise<Response> {
  const attachment = await getAttachment(deps.db, organizationId, attachmentId);
  if (!attachment) throw ApiRouteError.notFound(ATTACHMENT_NOT_FOUND_MESSAGE);
  const storage = storageOf(deps);
  let stored;
  try {
    stored = await storage.get(attachment.storageKey);
  } catch (error) {
    console.error(`Reading attachment ${attachment.storageKey} failed`, error);
    throw new ApiRouteError(
      502,
      "Reading the file failed. Try again in a moment.",
      "storage_failed",
    );
  }
  if (!stored) throw ApiRouteError.notFound(ATTACHMENT_NOT_FOUND_MESSAGE);
  const inline = !download && SHOWN_INLINE.test(attachment.contentType);
  return new Response(stored.body, {
    headers: {
      "content-type": attachment.contentType,
      "content-length": String(attachment.size),
      "content-disposition": contentDisposition(
        inline ? "inline" : "attachment",
        attachment.fileName,
      ),
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    },
  });
}

/**
 * Deletes the organization's attachment, then its file (a file that fails to delete is
 * logged and left behind: nothing points at it any more). 404 when there is none.
 */
export async function removeAttachment(
  deps: AttachmentDeps,
  organizationId: string,
  attachmentId: string,
): Promise<{ ok: true }> {
  const storage = storageOf(deps);
  const attachment = await deleteAttachment(deps.db, organizationId, attachmentId);
  if (!attachment) throw ApiRouteError.notFound(ATTACHMENT_NOT_FOUND_MESSAGE);
  await storage
    .delete(attachment.storageKey)
    .catch((error) =>
      console.error(`Deleting the file of attachment ${attachment.id} failed`, error),
    );
  return { ok: true };
}
