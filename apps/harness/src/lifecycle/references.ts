import { stat } from "node:fs/promises";
import path from "node:path";
import { extractFileReferences } from "@omniralph/engine";
import type { ChatAskFileReference } from "@omniralph/shared";

/** The answer's references to files that exist under `root` (the checkout), at most `limit`. */
export async function existingReferences(
  answer: string,
  root: string,
  limit: number,
): Promise<ChatAskFileReference[]> {
  const kept: ChatAskFileReference[] = [];
  for (const reference of extractFileReferences(answer)) {
    const file = path.resolve(root, reference.path);
    if (path.relative(root, file).startsWith("..")) continue;
    const isFile = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!isFile) continue;
    kept.push(reference);
    if (kept.length === limit) break;
  }
  return kept;
}
