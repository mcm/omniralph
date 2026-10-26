"use client";

import { Button, RadioList, RepoBadge, type RadioListOption } from "@omniralph/ui";
import { useState, type FormEvent } from "react";
import type { InboxItem } from "@/lib/api/inbox";
import type { RunQuestion } from "@/lib/api/runs";
import { useClock } from "@/screens/clock";
import { relativeUntil } from "@/screens/inbox/labels";
import { DecisionButtons } from "./decision-buttons";
import { useInboxDecisionPending } from "./use-inbox-decision";
import { useRunAnswer } from "./use-run-answer";
import "./question-form.css";

export type QuestionFormProps = {
  /** The run that asks. */
  runId: string;
  question: RunQuestion;
} & (
  | {
      /** In an Inbox item: Send answer, then the item's Done and Snooze (`inboxDecisions`). */
      variant: "inbox";
      item: InboxItem;
    }
  | {
      /** In the run detail: Send answer alone. */
      variant: "run";
      item?: undefined;
    }
);

/** The options as radios: a repo option shows the repo badge with its code-host mark. */
function radioOptions(question: RunQuestion): RadioListOption[] {
  return question.options.map(({ id, label, provider }) => ({
    value: id,
    label: provider ? <RepoBadge host={provider} name={label} /> : label,
  }));
}

/**
 * A run's open question and its answers (which repo to use, whether to run a manual story's
 * preparation, what to do with a merged PR/MR's leftovers, whether to allow a tool call): the
 * prompt with "Expires {relative time}" beside it when it has a deadline, the options as a
 * `RadioList`, and "Send answer" (primary, disabled until an option is chosen). Sending
 * posts `{questionKey, optionId}` and the run goes on (`useRunAnswer`).
 */
export function QuestionForm(props: QuestionFormProps) {
  const { runId, question } = props;
  // The choice belongs to its question: a new question starts unanswered.
  const [choice, setChoice] = useState<{ questionKey: string; optionId: string }>();
  const optionId = choice?.questionKey === question.key ? choice.optionId : undefined;
  const answer = useRunAnswer(runId, question.key);
  const pending = useInboxDecisionPending(question.key);
  const now = useClock();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!optionId || pending) return;
    answer.mutate({ questionKey: question.key, optionId });
  }

  const send = (
    <Button type="submit" variant="primary" disabled={!optionId || pending}>
      Send answer
    </Button>
  );

  return (
    <form className="or-question" aria-label="Answer" onSubmit={submit}>
      <RadioList
        label={question.prompt}
        aside={question.expiresAt ? `Expires ${relativeUntil(question.expiresAt, now)}` : undefined}
        options={radioOptions(question)}
        value={optionId}
        onValueChange={(id) => setChoice({ questionKey: question.key, optionId: id })}
        disabled={pending}
      />
      {props.variant === "inbox" ? (
        <DecisionButtons item={props.item} answer={send} />
      ) : (
        <div className="or-question__actions">{send}</div>
      )}
    </form>
  );
}
