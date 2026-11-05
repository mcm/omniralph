import type { StatusTone } from "@omniralph/ui";
import {
  ATTACHMENT_TYPES,
  attachmentContentType,
  MAX_ATTACHMENT_BYTES,
  type FeatureDocumentKindValue,
  type FeatureStatusValue,
} from "@/lib/api/features";

/** Where the Features screen lives, and one feature's page. */
export const FEATURES_PATH = "/features";
export const featureHref = (featureId: string) =>
  `${FEATURES_PATH}/${encodeURIComponent(featureId)}`;

/** A feature status's label and tone (Design rule 15). */
export const FEATURE_STATUS: Record<FeatureStatusValue, { label: string; tone: StatusTone }> = {
  planning: { label: "Planning", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

/** The documents of a feature, in tab order, with their names. */
export const FEATURE_DOCUMENTS: readonly { kind: FeatureDocumentKindValue; label: string }[] = [
  { kind: "prfaq", label: "PRFAQ" },
  { kind: "plan", label: "Plan" },
];

export const documentLabel = (kind: FeatureDocumentKindValue) =>
  FEATURE_DOCUMENTS.find((document) => document.kind === kind)!.label;

/** "No epics", "1 epic", "3 epics". */
export function epicCount(count: number): string {
  if (count === 0) return "No epics";
  return count === 1 ? "1 epic" : `${count} epics`;
}

/** A file size for people: "512 bytes", "12 KB", "1.5 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / 1024;
  return `${Number(megabytes.toFixed(1))} MB`;
}

/** How an attachment can be previewed in the panel: as an image, a PDF, or not at all. */
export function previewKind(contentType: string): "image" | "pdf" | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  return null;
}

/** The file picker's `accept`: every allowed type and its extensions. */
export const ATTACHMENT_ACCEPT = Object.entries(ATTACHMENT_TYPES)
  .flatMap(([type, extensions]) => [type, ...extensions])
  .join(",");

/** What the panel says it takes, under the drop zone. */
export const ATTACHMENT_HINT = `Images, PDFs, text, Markdown, CSV or JSON, up to ${formatBytes(MAX_ATTACHMENT_BYTES)} each.`;

/**
 * Why a file can't be attached, checked before it's sent with the server's own rules (it
 * checks again), or null when it can be.
 */
export function attachmentProblem(file: Pick<File, "name" | "size" | "type">): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name} is over ${formatBytes(MAX_ATTACHMENT_BYTES)}.`;
  }
  if (!attachmentContentType(file.name, file.type)) {
    return `${file.name} isn't a type you can attach.`;
  }
  return null;
}
