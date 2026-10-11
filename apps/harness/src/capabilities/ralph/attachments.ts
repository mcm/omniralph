import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  attachmentFileName,
  failedAttachmentsNote,
  formatAttachments,
  uniqueFileName,
  type AttachmentFile,
} from "@omniralph/ralph";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_DOWNLOADS_PER_JOB,
  type RalphAttachment,
} from "@omniralph/shared";
import type { FetchFn } from "../../api.js";
import type { Logger } from "../../logger.js";

/** Directory (under `workspaceRoot`) holding the Linear attachments of every epic, one folder each. */
export const ATTACHMENTS_DIR = ".attachments";

const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface DownloadResult {
  ok: boolean;
  contentType: string;
  data?: Buffer;
  error?: string;
}

/** Downloads one attachment of the job by its ID. */
export type AttachmentFetcher = (id: string) => Promise<DownloadResult>;

export interface ControlPanelFetcherOptions {
  server: string;
  jobId: string;
  /** The job's current token (`ralph:attachments` scope). */
  jobToken: () => string;
  fetch?: FetchFn;
  signal?: AbortSignal;
}

/** The body of `res`, or an error once it is larger than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer | string> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) {
      await res.body.cancel().catch(() => undefined);
      return `larger than ${max / 1024 / 1024} MB`;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads attachments through the control panel
 * (`GET /api/agent/jobs/{id}/attachments/{attachmentId}`), which fetches them
 * from Linear with its own token.
 */
export function controlPanelFetcher(options: ControlPanelFetcherOptions): AttachmentFetcher {
  const fetchFn = options.fetch ?? fetch;
  const base = `${options.server}/api/agent/jobs/${encodeURIComponent(options.jobId)}/attachments`;
  return async (id) => {
    try {
      const res = await fetchFn(`${base}/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${options.jobToken()}` },
        redirect: "error",
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
          : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as
          { reason?: unknown; error?: unknown } | undefined;
        const reason =
          typeof body?.reason === "string"
            ? body.reason
            : `HTTP ${res.status}${typeof body?.error === "string" ? ` (${body.error})` : ""}`;
        return { ok: false, contentType, error: reason };
      }
      if (contentType === "text/html") {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, contentType, error: "got an HTML page instead of the file" };
      }
      const data = await readCapped(res, MAX_ATTACHMENT_BYTES);
      if (typeof data === "string") return { ok: false, contentType, error: data };
      return { ok: true, contentType, data };
    } catch (error) {
      return {
        ok: false,
        contentType: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

interface CacheIndex {
  /** Attachment ID -> its file in the folder. */
  files: Record<string, { file: string; contentType: string }>;
  /** Attachments whose failed download was reported already (until one succeeds). */
  reported?: string[];
}

/** The folder of one epic's attachments: `<workspaceRoot>/.attachments/<EPIC>`. */
export function attachmentsDir(workspaceRoot: string, epicIdentifier: string): string {
  const safe = epicIdentifier.replace(/[^A-Za-z0-9_-]/g, "_") || "epic";
  return path.join(workspaceRoot, ATTACHMENTS_DIR, safe);
}

export interface CollectedAttachments {
  /** The epic's attachment folder (for the session's `additionalDirectories`). */
  dir: string;
  /** Every attachment of the payload, in order: downloaded (`path`) or not (`error`). */
  files: AttachmentFile[];
  /** The prompt's list (`formatAttachments`); undefined without attachments. */
  prompt?: string;
  /** The thought about failed downloads not reported before, if any. */
  failureNote?: string;
}

/**
 * Downloads the payload's attachments into the epic's folder, cached by
 * attachment ID across jobs (`.index.json`), at most `max` new files per call
 * (the rest are reported as skipped). Files are named by cyralph's rules: the
 * upload's sanitized title, else `attachment-N`, with an extension from the
 * content type, and `-2`, `-3`… on collisions.
 */
export async function collectAttachments(options: {
  attachments: readonly RalphAttachment[];
  dir: string;
  fetcher: AttachmentFetcher;
  max?: number;
  logger?: Logger;
}): Promise<CollectedAttachments> {
  const { dir, fetcher } = options;
  const max = options.max ?? MAX_ATTACHMENT_DOWNLOADS_PER_JOB;
  if (options.attachments.length === 0) return { dir, files: [] };

  await mkdir(dir, { recursive: true });
  const indexPath = path.join(dir, ".index.json");
  let index: CacheIndex = { files: {} };
  try {
    index = JSON.parse(await readFile(indexPath, "utf8")) as CacheIndex;
  } catch {
    // first download for this epic
  }
  const used = new Set(Object.values(index.files).map((f) => f.file));
  const reported = new Set(index.reported ?? []);

  let fetched = 0;
  let unnamed = Object.keys(index.files).length;
  const files: Array<AttachmentFile & { id: string }> = [];
  for (const attachment of options.attachments) {
    const entry = { id: attachment.id, title: attachment.title, sources: attachment.sources };
    const cached = index.files[attachment.id];
    if (cached && existsSync(path.join(dir, cached.file))) {
      files.push({ ...entry, path: path.join(dir, cached.file) });
      continue;
    }
    if (fetched >= max) {
      files.push({ ...entry, error: `skipped: more than ${max} attachments` });
      continue;
    }
    fetched++;
    const result = await fetcher(attachment.id);
    if (!result.ok || !result.data) {
      files.push({ ...entry, error: result.error ?? "unknown error" });
      continue;
    }
    const file = uniqueFileName(
      attachmentFileName(attachment, result.contentType, `attachment-${unnamed + 1}`),
      used,
    );
    if (!attachment.title) unnamed++;
    used.add(file);
    await writeFile(path.join(dir, file), result.data);
    index.files[attachment.id] = { file, contentType: result.contentType };
    files.push({ ...entry, path: path.join(dir, file) });
  }

  const failed = files.filter((f) => !f.path);
  const unreported = failed.filter((f) => !reported.has(f.id));
  for (const f of files) {
    if (f.path) reported.delete(f.id);
    else reported.add(f.id);
  }
  index.reported = [...reported];
  await writeFile(indexPath, JSON.stringify(index, null, 2));
  if (failed.length > 0) {
    options.logger?.warn(
      { failed: failed.map((f) => ({ id: f.id, error: f.error })) },
      "some Linear attachments could not be downloaded",
    );
  }
  const failureNote = failedAttachmentsNote(unreported, files.length);
  return {
    dir,
    files,
    ...(files.length > 0 && { prompt: formatAttachments(files) }),
    ...(failureNote && { failureNote }),
  };
}

/**
 * The job's attachments, downloaded through the control panel into the
 * epic's folder under `workspaceRoot`. Failed downloads not reported before
 * are posted as one thought. A failure of the cache itself is logged and
 * leaves the prompt without attachments.
 */
export async function jobAttachments(options: {
  attachments: readonly RalphAttachment[];
  epicIdentifier: string;
  workspaceRoot: string;
  fetcher: AttachmentFetcher;
  logger: Logger;
  /** Posts the failure thought (the job's activity relay). */
  report: (note: string) => void;
}): Promise<CollectedAttachments> {
  const dir = attachmentsDir(options.workspaceRoot, options.epicIdentifier);
  try {
    const collected = await collectAttachments({
      attachments: options.attachments,
      dir,
      fetcher: options.fetcher,
      logger: options.logger,
    });
    if (collected.failureNote) options.report(collected.failureNote);
    return collected;
  } catch (error) {
    options.logger.warn({ err: error }, "downloading the Linear attachments failed");
    return { dir, files: [] };
  }
}
