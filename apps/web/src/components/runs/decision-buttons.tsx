"use client";

import { Button, Menu } from "@omniralph/ui";
import { IconChevronDown } from "@tabler/icons-react";
import { Fragment, type ReactNode } from "react";
import type { InboxItem, InboxItemAction } from "@/lib/api/inbox";
import { inboxDecisions, SNOOZE_CHOICES, SNOOZE_LABELS, snoozeUntil } from "./decisions";
import { useInboxDecision, useInboxDecisionPending } from "./use-inbox-decision";
import "./decision-buttons.css";

/**
 * An Inbox item's decisions as labeled buttons (`inboxDecisions`): the clearing action
 * first and the only lavender one, then the rest in `outline`. Snooze opens a menu of 1
 * hour, Tomorrow and Next week. A click posts the decision and the item leaves its feed
 * at once; while it is pending, the item's buttons are disabled. A question's Send answer
 * is the `answer` slot (the question form's submit), rendered in its place.
 */
export function DecisionButtons({ item, answer }: { item: InboxItem; answer?: ReactNode }) {
  const decide = useInboxDecision(item);
  const pending = useInboxDecisionPending(item.key);
  const decisions = inboxDecisions(item);
  if (decisions.length === 0) return null;

  const post = (action: Exclude<InboxItemAction, "snooze" | "restore">) =>
    decide.mutate({ action });

  return (
    <div className="or-decisions" role="group" aria-label="Decisions">
      {decisions.map(({ action, label, variant }) => {
        if (action === "answer") return <Fragment key={action}>{answer}</Fragment>;
        if (action === "snooze") {
          return (
            <Menu
              key={action}
              align="start"
              disabled={pending}
              items={SNOOZE_CHOICES.map((choice) => ({
                label: SNOOZE_LABELS[choice],
                onSelect: () =>
                  decide.mutate({
                    action: "snooze",
                    until: snoozeUntil(choice, new Date()).toISOString(),
                  }),
              }))}
              trigger={
                <Button variant={variant} disabled={pending}>
                  {label}
                  <IconChevronDown size={14} stroke={1.75} aria-hidden="true" />
                </Button>
              }
            />
          );
        }
        return (
          <Button key={action} variant={variant} disabled={pending} onClick={() => post(action)}>
            {label}
          </Button>
        );
      })}
    </div>
  );
}
