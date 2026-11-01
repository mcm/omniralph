"use client";

import { Button, Menu } from "@omniralph/ui";
import {
  IconChevronDown,
  IconExternalLink,
  IconFileText,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { Fragment, useState, type ReactNode } from "react";
import { useStartWorkItem } from "@/components/work-items/use-work-item-actions";
import { ViewPrdSheet } from "@/components/work-items/view-prd-sheet";
import type { InboxAction, InboxItem, InboxItemAction } from "@/lib/api/inbox";
import { useKeyShortcuts, useShortcut, type ShortcutId } from "@/lib/shortcuts";
import {
  inboxCtas,
  SNOOZE_CHOICES,
  SNOOZE_LABELS,
  snoozeUntil,
  type InboxCta,
  type InboxDecision,
  type InboxLink,
  type InboxPrd,
  type InboxStart,
} from "./decisions";
import { RunDetailOverlayProvider, useRunDetailOverlay } from "./run-detail-overlay";
import { useScopeParam } from "@/screens/scope";
import {
  inboxDecisionKey,
  removeFromInbox,
  useInboxDecision,
  useInboxDecisionPending,
} from "./use-inbox-decision";
import "./decision-buttons.css";

/** The shortcut of each decision with a key (a question's Send answer has none). */
const DECISION_SHORTCUTS: Partial<Record<InboxAction, ShortcutId>> = {
  done: "done",
  skip: "skip",
  snooze: "snooze",
  start_anyway: "startAnyway",
  resume: "resume",
  retry: "retry",
};

/** The shortcut of each step with a key. */
const STEP_SHORTCUTS: Partial<Record<InboxCta["type"] | InboxLink["step"], ShortcutId>> = {
  prd: "viewPrd",
  open_pr: "openPullRequest",
};

type PostedAction = Exclude<InboxItemAction, "snooze" | "restore">;

/**
 * An Inbox item's calls to action (`inboxCtas`), in one row: what's next first and the only
 * lavender one (Open PR/MR for a PR waiting on review, Start epic for a ready PRD
 * without open questions (Review PRD with some), the
 * clearing decision otherwise), then the other ways forward (Open run, View PRD), then
 * Dismiss and Snooze, quiet. Snooze opens a menu of 1 hour, Tomorrow and Next week. A
 * decision posts and the item leaves its feed at once; while it is pending, the item's
 * decisions are disabled. View PRD opens the PRD in a sheet, without leaving the Inbox. A
 * question's Send answer is the `answer` slot (the question form's submit).
 *
 * `steps="primary"` (the phone's inline row) keeps only the lead step of the links and PRD.
 * With `bindShortcuts` (the Inbox detail pane only), each shown decision's key performs it
 * as a click does (Done/Dismiss `e`, Skip story `s`, Start anyway `t`, Resume `c`, Retry
 * `r`), Snooze's (`z`) opens its menu, View PRD's (`v`) opens the sheet and Open PR/MR's
 * (`p`) opens it in a new tab.
 */
export function DecisionButtons({
  item,
  answer,
  bindShortcuts = false,
  steps = "all",
}: {
  item: InboxItem;
  answer?: ReactNode;
  bindShortcuts?: boolean;
  steps?: "all" | "primary";
}) {
  const ctas = inboxCtas(item).filter(
    (cta) => steps === "all" || cta.type === "decision" || cta.variant === "primary",
  );
  if (ctas.length === 0) return null;
  return (
    <RunDetailOverlayProvider>
      <Ctas item={item} ctas={ctas} answer={answer} bindShortcuts={bindShortcuts} />
    </RunDetailOverlayProvider>
  );
}

function Ctas({
  item,
  ctas,
  answer,
  bindShortcuts,
}: {
  item: InboxItem;
  ctas: InboxCta[];
  answer?: ReactNode;
  bindShortcuts: boolean;
}) {
  const decide = useInboxDecision(item);
  const pending = useInboxDecisionPending(item.key);
  const post = (action: PostedAction) => decide.mutate({ action });
  const snooze = (until: Date) => decide.mutate({ action: "snooze", until: until.toISOString() });

  return (
    <div className="or-decisions" role="group" aria-label="Decisions">
      {ctas.map((cta) => {
        if (cta.type === "prd") {
          const shortcut = (bindShortcuts && STEP_SHORTCUTS.prd) || null;
          return <PrdButton key={cta.step} cta={cta} shortcut={shortcut} />;
        }
        if (cta.type === "start") {
          return <StartButton key={cta.step} item={item} cta={cta} pending={pending} />;
        }
        if (cta.type === "link") {
          const shortcut = (bindShortcuts && STEP_SHORTCUTS[cta.step]) || null;
          return <LinkButton key={cta.step} cta={cta} shortcut={shortcut} />;
        }
        const { action } = cta;
        if (action === "answer") return <Fragment key={action}>{answer}</Fragment>;
        const shortcut = (bindShortcuts && DECISION_SHORTCUTS[action]) || null;
        if (action === "snooze") {
          return (
            <SnoozeButton
              key={action}
              decision={cta}
              pending={pending}
              shortcut={shortcut}
              onSnooze={snooze}
            />
          );
        }
        return (
          <DecisionButton
            key={action}
            decision={cta}
            pending={pending}
            shortcut={shortcut}
            onDecide={() => post(action)}
          />
        );
      })}
    </div>
  );
}

/**
 * Start epic: starts the work item's run (`useStartWorkItem`); the item leaves the Inbox at
 * once, and comes back with the server's message if the start is refused.
 */
function StartButton({
  item,
  cta,
  pending,
}: {
  item: InboxItem;
  cta: InboxStart;
  pending: boolean;
}) {
  const scope = useScopeParam();
  const start = useStartWorkItem({
    mutationKey: inboxDecisionKey(item.key),
    optimistic: (cache) => removeFromInbox(cache, scope, item.key, [item.tab]),
    invalidate: (keys) => [keys.inbox.all, keys.runs.all],
  });
  return (
    <Button
      variant={cta.variant}
      icon={IconPlayerPlay}
      disabled={pending}
      onClick={() => start.mutate(cta.workItem)}
    >
      {cta.label}
    </Button>
  );
}

function LinkButton({ cta, shortcut }: { cta: InboxLink; shortcut: ShortcutId | null }) {
  useShortcut(shortcut, () => {
    window.open(cta.href, "_blank", "noopener,noreferrer");
  });
  const keys = useKeyShortcuts(shortcut);
  return (
    <Button
      variant={cta.variant}
      href={cta.href}
      icon={cta.external ? IconExternalLink : undefined}
      aria-keyshortcuts={keys}
      {...(cta.external && { target: "_blank", rel: "noopener noreferrer" })}
    >
      {cta.label}
    </Button>
  );
}

function PrdButton({ cta, shortcut }: { cta: InboxPrd; shortcut: ShortcutId | null }) {
  const overlay = useRunDetailOverlay();
  const open = () => overlay.open(<ViewPrdSheet runId={cta.runId} workItem={cta.workItem} />);
  useShortcut(shortcut, open);
  return (
    <Button
      variant={cta.variant}
      icon={IconFileText}
      onClick={open}
      aria-keyshortcuts={useKeyShortcuts(shortcut)}
    >
      {cta.label}
    </Button>
  );
}

function DecisionButton({
  decision,
  pending,
  shortcut,
  onDecide,
}: {
  decision: InboxDecision;
  pending: boolean;
  shortcut: ShortcutId | null;
  onDecide: () => void;
}) {
  useShortcut(shortcut, onDecide, { enabled: !pending });
  return (
    <Button
      variant={decision.variant}
      disabled={pending}
      onClick={onDecide}
      aria-keyshortcuts={useKeyShortcuts(shortcut)}
    >
      {decision.label}
    </Button>
  );
}

function SnoozeButton({
  decision,
  pending,
  shortcut,
  onSnooze,
}: {
  decision: InboxDecision;
  pending: boolean;
  shortcut: ShortcutId | null;
  onSnooze: (until: Date) => void;
}) {
  const [open, setOpen] = useState(false);
  useShortcut(shortcut, () => setOpen(true), { enabled: !pending });
  const keys = useKeyShortcuts(shortcut);
  return (
    <Menu
      align="start"
      disabled={pending}
      open={open}
      onOpenChange={setOpen}
      items={SNOOZE_CHOICES.map((choice) => ({
        label: SNOOZE_LABELS[choice],
        onSelect: () => onSnooze(snoozeUntil(choice, new Date())),
      }))}
      trigger={
        <Button variant={decision.variant} disabled={pending} aria-keyshortcuts={keys}>
          {decision.label}
          <IconChevronDown size={14} stroke={1.75} aria-hidden="true" />
        </Button>
      }
    />
  );
}
