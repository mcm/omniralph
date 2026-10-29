"use client";

import { Button, Menu } from "@omniralph/ui";
import { IconChevronDown } from "@tabler/icons-react";
import { Fragment, useState, type ReactNode } from "react";
import type { InboxAction, InboxItem, InboxItemAction } from "@/lib/api/inbox";
import { useKeyShortcuts, useShortcut, type ShortcutId } from "@/lib/shortcuts";
import {
  inboxDecisions,
  SNOOZE_CHOICES,
  SNOOZE_LABELS,
  snoozeUntil,
  type InboxDecision,
} from "./decisions";
import { useInboxDecision, useInboxDecisionPending } from "./use-inbox-decision";
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

type PostedAction = Exclude<InboxItemAction, "snooze" | "restore">;

/**
 * An Inbox item's decisions as labeled buttons (`inboxDecisions`): the clearing action
 * first and the only lavender one, then the rest in `outline`. Snooze opens a menu of 1
 * hour, Tomorrow and Next week. A click posts the decision and the item leaves its feed
 * at once; while it is pending, the item's buttons are disabled. A question's Send answer
 * is the `answer` slot (the question form's submit), rendered in its place.
 *
 * With `bindShortcuts` (the Inbox detail pane only, never the phone's inline row), each
 * shown decision's key performs it as a click does (Done `e`, Skip story `s`, Start anyway
 * `t`, Resume `c`, Retry `r`) and Snooze's (`z`) opens its menu, while the buttons are enabled.
 */
export function DecisionButtons({
  item,
  answer,
  bindShortcuts = false,
}: {
  item: InboxItem;
  answer?: ReactNode;
  bindShortcuts?: boolean;
}) {
  const decide = useInboxDecision(item);
  const pending = useInboxDecisionPending(item.key);
  const decisions = inboxDecisions(item);
  if (decisions.length === 0) return null;

  const post = (action: PostedAction) => decide.mutate({ action });
  const snooze = (until: Date) => decide.mutate({ action: "snooze", until: until.toISOString() });

  return (
    <div className="or-decisions" role="group" aria-label="Decisions">
      {decisions.map((decision) => {
        const { action } = decision;
        if (action === "answer") return <Fragment key={action}>{answer}</Fragment>;
        const shortcut = (bindShortcuts && DECISION_SHORTCUTS[action]) || null;
        if (action === "snooze") {
          return (
            <SnoozeButton
              key={action}
              decision={decision}
              pending={pending}
              shortcut={shortcut}
              onSnooze={snooze}
            />
          );
        }
        return (
          <DecisionButton
            key={action}
            decision={decision}
            pending={pending}
            shortcut={shortcut}
            onDecide={() => post(action)}
          />
        );
      })}
    </div>
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
