import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachmentFileName, formatRunFiles, uniqueFileName, type RunFile } from "@omniralph/ralph";
import { MAX_ATTACHMENT_BYTES, type RunAttachment } from "@omniralph/shared";
import type { FetchFn } from "../api.js";
import type { Logger } from "../logger.js";

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** The run's Omniralph attachments, downloaded into a folder of their own outside the repo. */
export interface DownloadedRunAttachments {
  /** The folder holding them (for the session's `additionalDirectories`); null without any. */
  dir: string | null;
  files: RunFile[];
  /** The prompt's list (`formatRunFiles`); undefined without any. */
  prompt?: string;
  /** Deletes the folder; never throws. */
  remove(): Promise<void>;
}

/** An attachment of the run couldn't be downloaded: the run fails with this message. */
export class RunAttachmentDownloadError extends Error {
  override name = "RunAttachmentDownloadError";
}

function labelOf(attachment: RunAttachment): string {
  const owner =
    attachment.owner === "feature"
      ? `the feature "${attachment.ownerName}"`
      : `${attachment.ownerName}`;
  return `"${attachment.fileName}" (attached to ${owner})`;
}

/** The body of `res`, or why it can't be used. */
async function readBody(res: Response, max: number): Promise<Buffer | string> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) {
      await res.body.cancel().catch(() => undefined);
      return `it is larger than ${max / 1024 / 1024} MB`;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads the files attached in Omniralph to the run's epic and its feature (the run
 * spec's `attachments`) from their short-lived URLs into a new temporary folder, outside
 * any repo checkout, so they can never be committed: `feature/` and `epic/` subfolders,
 * each file under its sanitized name (`-2`, `-3`… on collisions). Any failed download (an
 * expired link, an HTTP error, a file over `MAX_ATTACHMENT_BYTES`, a timeout) removes the
 * folder and throws `RunAttachmentDownloadError` naming the file and why, which fails the
 * run before its first session. Without attachments nothing is created.
 */
export async function downloadRunAttachments(options: {
  attachments: readonly RunAttachment[];
  fetch?: FetchFn;
  signal?: AbortSignal;
  logger?: Logger;
  /** Parent of the folder; defaults to the OS temp directory. */
  tmpDir?: string;
  now?: () => Date;
}): Promise<DownloadedRunAttachments> {
  const { attachments } = options;
  if (attachments.length === 0) return { dir: null, files: [], remove: async () => {} };
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const dir = await mkdtemp(path.join(options.tmpDir ?? tmpdir(), "omniralph-attachments-"));
  const remove = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const used = { feature: new Set<string>(), epic: new Set<string>() };
  const files: RunFile[] = [];
  try {
    for (const attachment of attachments) {
      const fail = (reason: string) =>
        new RunAttachmentDownloadError(
          `Couldn't download the attachment ${labelOf(attachment)}: ${reason}`,
        );
      if (Date.parse(attachment.expiresAt) <= now().getTime()) {
        throw fail("its download link expired before the run started");
      }
      let res: Response;
      try {
        res = await fetchFn(attachment.url, {
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
            : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw fail(error instanceof Error ? error.message : String(error));
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw fail(`the file store answered HTTP ${res.status}`);
      }
      const body = await readBody(res, MAX_ATTACHMENT_BYTES);
      if (typeof body === "string") throw fail(body);
      const folder = path.join(dir, attachment.owner);
      await mkdir(folder, { recursive: true });
      const name = uniqueFileName(
        attachmentFileName(
          // No backticks either: the prompt quotes the path in code spans.
          { title: attachment.fileName.replace(/`/g, "_") },
          attachment.contentType,
          `attachment-${files.length + 1}`,
        ),
        used[attachment.owner],
      );
      used[attachment.owner].add(name);
      const file = path.join(folder, name);
      await writeFile(file, body);
      files.push({
        path: file,
        name: attachment.fileName,
        contentType: attachment.contentType,
        owner: attachment.owner,
        ownerName: attachment.ownerName,
      });
    }
  } catch (error) {
    await remove();
    if (error instanceof RunAttachmentDownloadError) {
      options.logger?.warn({ err: error }, "downloading the run's attachments failed");
    }
    throw error;
  }
  options.logger?.info({ dir, count: files.length }, "downloaded the run's attachments");
  return { dir, files, prompt: formatRunFiles(files), remove };
}
