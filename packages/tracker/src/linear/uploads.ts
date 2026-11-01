/**
 * Linear's uploads: files pasted into issues and comments (screenshots,
 * mockups, PDFs) live at `https://uploads.linear.app/...` and need the
 * workspace token to download (ported from cyralph's `src/linear/attachments.ts`).
 */
import type { UploadRef } from "../types.js";

/** Linear's upload storage. */
const UPLOAD_URL = /https:\/\/uploads\.linear\.app\/[A-Za-z0-9/_.-]+/;

/** The upload URL in `url` without its signed query (and sentence punctuation), if it is one. */
function unsignedUploadUrl(url: string): string | undefined {
  // Sentence punctuation after a bare URL isn't part of it.
  return UPLOAD_URL.exec(url)?.[0]?.replace(/[.]+$/, "");
}

/** Whether `url` is exactly an (unsigned) Linear upload URL. */
export function isLinearUploadUrl(url: string): boolean {
  return new RegExp(`^${UPLOAD_URL.source}$`).test(url) && !url.endsWith(".");
}

/**
 * The Linear uploads referenced in markdown: Linear's
 * `<linear-image>{json}</linear-image>` blocks, `![title](url)` / `[title](url)`
 * links, and bare upload URLs. Deduplicated by unsigned URL.
 */
export function findLinearUploads(text: string | undefined | null): UploadRef[] {
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
