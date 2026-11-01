/**
 * Files uploaded to Linear (pasted screenshots, mockups, PDFs) live at
 * `https://uploads.linear.app/...` and need the workspace token to download
 * (ported from cyralph's `src/linear/attachments.ts`). The control panel finds
 * them in the run's Linear text and lists them in job payloads; agents
 * download them through the control panel and list them in the prompt, so the
 * session can open them with the Read tool (which shows images to Claude).
 */

export interface UploadRef {
  /** Upload URL without the expiring `?signature=...` query. */
  url: string;
  /** Name Linear stores with the upload (e.g. "mockup.png"), when known. */
  title?: string;
}

const UPLOAD_URL = /https:\/\/uploads\.linear\.app\/[A-Za-z0-9/_.-]+/;

/** The upload URL in `url` without its signed query (and sentence punctuation), if it is one. */
export function unsignedUploadUrl(url: string): string | undefined {
  // Sentence punctuation after a bare URL isn't part of it.
  return UPLOAD_URL.exec(url)?.[0]?.replace(/[.]+$/, "");
}

/** Whether `url` is exactly an (unsigned) Linear upload URL. */
export function isUploadUrl(url: string): boolean {
  return unsignedUploadUrl(url) === url;
}

/**
 * Find upload references in markdown: Linear's `<linear-image>{json}</linear-image>` blocks,
 * `![title](url)` / `[title](url)` links, and bare upload URLs. Deduplicated by unsigned URL.
 */
export function extractUploads(text: string | undefined | null): UploadRef[] {
  if (!text) return [];
  const found = new Map<string, UploadRef>();
  const add = (rawUrl: string, title?: string) => {
    const url = unsignedUploadUrl(rawUrl);
    if (!url) return;
    const existing = found.get(url);
    if (!existing) found.set(url, { url, ...(title?.trim() && { title: title.trim() }) });
    else if (!existing.title && title?.trim()) existing.title = title.trim();
  };
  for (const m of text.matchAll(/<linear-image>([\s\S]*?)<\/linear-image>/g)) {
    try {
      const data = JSON.parse(m[1] ?? "") as {
        attrs?: { src?: string; title?: string; alt?: string };
      };
      if (data.attrs?.src) add(data.attrs.src, data.attrs.title ?? data.attrs.alt);
    } catch {
      // fall through to URL scanning
    }
  }
  for (const m of text.matchAll(/!?\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g)) {
    if (m[2]) add(m[2], m[1]);
  }
  for (const m of text.matchAll(new RegExp(UPLOAD_URL.source, "g"))) add(m[0]);
  return [...found.values()];
}

export interface AttachmentSource {
  /** Where the text came from, e.g. "ENG-1 description", "US-002", "comment by Ana". */
  label: string;
  text: string | undefined | null;
  /** Story key this source belongs to (story-scoped attachments only go to that story's prompt). */
  storyKey?: string;
}

export interface GatheredAttachment {
  url: string;
  title?: string;
  /** Labels of every source that referenced it. */
  sources: string[];
  storyKeys: string[];
  /** Referenced by something not tied to one story (epic description, thread, epic comments). */
  shared: boolean;
}

/** Every upload referenced by `sources`, deduplicated by URL, with where it was seen and its scope. */
export function gatherAttachments(sources: readonly AttachmentSource[]): GatheredAttachment[] {
  const entries = new Map<string, GatheredAttachment>();
  for (const src of sources) {
    for (const ref of extractUploads(src.text)) {
      const e = entries.get(ref.url) ?? {
        url: ref.url,
        ...(ref.title && { title: ref.title }),
        sources: [],
        storyKeys: [],
        shared: false,
      };
      e.title ??= ref.title;
      if (!e.sources.includes(src.label)) e.sources.push(src.label);
      if (!src.storyKey) e.shared = true;
      else if (!e.storyKeys.includes(src.storyKey)) e.storyKeys.push(src.storyKey);
      entries.set(ref.url, e);
    }
  }
  return [...entries.values()];
}

/** Attachments relevant to one story: its own plus anything not tied to a specific story. */
export function attachmentsForStory<T extends Pick<GatheredAttachment, "shared" | "storyKeys">>(
  entries: readonly T[],
  storyKey: string,
): T[] {
  return entries.filter((e) => e.shared || e.storyKeys.includes(storyKey));
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

function extname(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** A safe local filename: the upload's title when it has an extension, else title/fallback + type extension. */
export function attachmentFileName(
  ref: { title?: string | null },
  contentType: string,
  fallback: string,
): string {
  const base = (ref.title ?? "")
    // eslint-disable-next-line no-control-regex -- stripping control characters from file names is the point
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  const typeExt = EXT_BY_TYPE[contentType] ?? "";
  if (base && /^\.[A-Za-z0-9]{1,8}$/.test(extname(base))) return base;
  return `${base || fallback}${typeExt || ".bin"}`;
}

/** `file`, or `<stem>-N<ext>` with the first N from 2 that isn't `used`. */
export function uniqueFileName(file: string, used: ReadonlySet<string>): string {
  if (!used.has(file)) return file;
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length);
  let i = 2;
  while (used.has(`${stem}-${i}${ext}`)) i++;
  return `${stem}-${i}${ext}`;
}

/** An attachment as a job sees it: downloaded to `path`, or not (`error`). */
export interface AttachmentFile {
  title?: string | null;
  sources: readonly string[];
  /** Local file, when downloaded. */
  path?: string;
  error?: string;
}

/** Markdown list for prompts. */
export function formatAttachments(entries: readonly AttachmentFile[]): string | undefined {
  if (entries.length === 0) return undefined;
  return entries
    .map((e) => {
      const name = e.title ? `**${e.title}**` : "attachment";
      const from = `(from ${e.sources.join(", ")})`;
      return e.path
        ? `- ${name} ${from}: \`${e.path}\``
        : `- ${name} ${from}: could not be downloaded (${e.error ?? "unknown error"}). Don't guess what it shows; say so if it matters.`;
    })
    .join("\n");
}

/** The thought reporting attachments that couldn't be downloaded, or undefined when none failed. */
export function failedAttachmentsNote(
  failed: readonly AttachmentFile[],
  total: number,
): string | undefined {
  if (failed.length === 0) return undefined;
  return `I couldn't download ${failed.length} of ${total} attachment(s) from the tracker, so I can't see them:\n\n${failed
    .map(
      (e) =>
        `- ${e.title ?? "attachment"} (${e.sources.join(", ")}): ${e.error ?? "unknown error"}`,
    )
    .join("\n")}`;
}
