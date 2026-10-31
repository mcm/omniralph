import { BrandMark, Glyph } from "@omniralph/ui";
import {
  IconAutomation,
  IconBrandGit,
  IconEye,
  IconListSearch,
  IconMessage2,
  IconMessageAi,
  IconMessageQuestion,
  IconSpy,
  IconStack2,
  type TablerIcon,
} from "@tabler/icons-react";
import type { RUN_KINDS } from "@/lib/api/runs";

type RunKind = (typeof RUN_KINDS)[number];

/**
 * Each run kind's icon: a list row's avatar, and the kind badge in a run's or an Inbox item's
 * header.
 */
export const RUN_KIND_ICONS: Readonly<Record<RunKind, TablerIcon>> = {
  epic: IconStack2,
  request: IconMessage2,
  review: IconEye,
  triage: IconListSearch,
  ask: IconMessageQuestion,
};

/** An agent's icon (an Inbox item about an agent). */
export const AGENT_ICON: TablerIcon = IconSpy;

/** Background work's icon (a failed system job in the Inbox). */
export const BACKGROUND_WORK_ICON: TablerIcon = IconAutomation;

/** An Ask chat's icon (the chat list). */
export const CHAT_ICON: TablerIcon = IconMessageAi;

/** A row avatar's icon: decorative, since the row's dot or title names what it is. */
export function AvatarIcon({ icon: Icon }: { icon: TablerIcon }) {
  return <Icon size={16} stroke={1.75} aria-hidden="true" />;
}

/** A work item's avatar: its tracker's mark (Linear), else Omniralph's. */
export function TrackerMark({ tracker }: { tracker: string }) {
  return tracker === "linear" ? (
    <BrandMark brand="linear" size={16} />
  ) : (
    <Glyph size={16} label="Omniralph" />
  );
}

/** A repo's avatar: its code host's mark (GitHub, GitLab), else Git's. */
export function CodeHostMark({ provider }: { provider: string }) {
  if (provider === "github" || provider === "gitlab")
    return <BrandMark brand={provider} size={16} />;
  return <IconBrandGit size={16} stroke={1.75} role="img" aria-label="Git" />;
}
