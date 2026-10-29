import {
  IconEye,
  IconListSearch,
  IconMessage2,
  IconMessageQuestion,
  IconStack2,
  type TablerIcon,
} from "@tabler/icons-react";
import type { RUN_KINDS } from "@/lib/api/runs";

type RunKind = (typeof RUN_KINDS)[number];

/** Each run kind as a row label and kind badge name it. */
export const RUN_KIND_LABELS: Readonly<Record<RunKind, string>> = {
  epic: "Epic",
  request: "Request",
  review: "Review",
  triage: "Triage",
  ask: "Ask",
};

/** Each run kind's icon (Design rule 21): the one map of every kind badge, Inbox and Runs alike. */
export const RUN_KIND_ICONS: Readonly<Record<RunKind, TablerIcon>> = {
  epic: IconStack2,
  request: IconMessage2,
  review: IconEye,
  triage: IconListSearch,
  ask: IconMessageQuestion,
};
