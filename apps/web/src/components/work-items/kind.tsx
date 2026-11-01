"use client";

import { MetaBadge } from "@omniralph/ui";
import { IconBug, IconSparkles } from "@tabler/icons-react";
import type { WorkItemRow } from "@/lib/api/work-items";

/**
 * A task's kind as a badge: "Fix" (it has one of the tracker's fix labels) or "Story" (new
 * work). Nothing renders for an epic or a feature (no kind). The one kind badge of the Backlog
 * list and the work item detail.
 */
export function KindBadge({ kind }: { kind: WorkItemRow["kind"] }) {
  if (!kind) return null;
  return kind === "fix" ? (
    <MetaBadge icon={IconBug} text="Fix" />
  ) : (
    <MetaBadge icon={IconSparkles} text="Story" />
  );
}
