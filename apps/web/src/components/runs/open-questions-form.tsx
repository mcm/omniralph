"use client";

import { Button, Textarea } from "@omniralph/ui";
import { useId, useState, type FormEvent } from "react";
import type { InboxItem } from "@/lib/api/inbox";
import { TRIAGE_ANSWER_MAX_LENGTH, type TriageAnswer } from "@/lib/api/runs";
import { DecisionButtons } from "./decision-buttons";
import { useTriageAnswers } from "./use-triage-answers";
import "./open-questions-form.css";

/** The form's accessible name. */
export const OPEN_QUESTIONS_FORM = "Answer the open questions";
/** Its submit button. */
export const SEND_ANSWERS = "Send answers";

export type OpenQuestionsFormProps = {
  /** The triage run that left the questions. */
  runId: string;
  /** The run's open questions, as its triage summary lists them. */
  questions: readonly string[];
} & (
  | {
      /** In an Inbox item: Send answers leads the item's other calls to action. */
      variant: "inbox";
      item: InboxItem;
      /** Binds the decisions' keyboard shortcuts (the Inbox detail pane). */
      bindShortcuts?: boolean;
    }
  | {
      /** In the Triage card, the View PRD sheet or the PRD tab: Send answers alone. */
      variant?: "plain";
      item?: undefined;
      bindShortcuts?: undefined;
    }
);

/** The non-blank answers, in question order, with the question each answers. */
export function answeredQuestions(
  questions: readonly string[],
  answers: Readonly<Record<number, string>>,
): TriageAnswer[] {
  return questions.flatMap((question, index) => {
    const answer = answers[index]?.trim();
    return answer ? [{ index, question, answer }] : [];
  });
}

/**
 * A triage's open questions, numbered, each with a textarea for its answer, and "Send
 * answers" (primary, disabled until an answer is written and while sending). Sending posts
 * the answered questions alone, as one reply (`useTriageAnswers`); the form clears once
 * sent. A refused send keeps the answers and shows why. New questions start a new form.
 */
export function OpenQuestionsForm(props: OpenQuestionsFormProps) {
  return <Form key={props.questions.join("\u0000")} {...props} />;
}

function Form(props: OpenQuestionsFormProps) {
  const { runId, questions } = props;
  const id = useId();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const send = useTriageAnswers(runId);
  const answered = answeredQuestions(questions, answers);
  const disabled = answered.length === 0 || send.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    send.mutate({ answers: answered }, { onSuccess: () => setAnswers({}) });
  }

  const button = (
    <Button type="submit" variant="primary" disabled={disabled}>
      {SEND_ANSWERS}
    </Button>
  );

  return (
    <form className="or-open-questions" aria-label={OPEN_QUESTIONS_FORM} onSubmit={submit}>
      <ol className="or-open-questions__list">
        {questions.map((question, index) => (
          <li key={index} className="or-open-questions__item">
            <label className="or-open-questions__question" htmlFor={`${id}-${index}`}>
              {question}
            </label>
            <Textarea
              id={`${id}-${index}`}
              rows={3}
              maxLength={TRIAGE_ANSWER_MAX_LENGTH}
              value={answers[index] ?? ""}
              disabled={send.isPending}
              onChange={(event) => {
                const value = event.target.value;
                setAnswers((previous) => ({ ...previous, [index]: value }));
              }}
            />
          </li>
        ))}
      </ol>
      {send.error ? (
        <p className="or-open-questions__error" role="alert">
          {send.error.message}
        </p>
      ) : null}
      {props.variant === "inbox" ? (
        <DecisionButtons item={props.item} answer={button} bindShortcuts={props.bindShortcuts} />
      ) : (
        <div className="or-open-questions__actions">{button}</div>
      )}
    </form>
  );
}
