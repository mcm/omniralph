"use client";

import { DiffView, MetaBadge, StatusDot, TextLink, type StatusTone } from "@omniralph/ui";
import { useId } from "react";
import type { RunIterationView, TriageRoundView, TriageSizingView } from "@/lib/api/runs";
import "./loop-views.css";
import "./triage-summary.css";

/** What each triage size reads as. */
export const TRIAGE_SIZE_WORDS: Record<TriageSizingView["size"], string> = {
  fix: "Fix",
  story: "Story",
  epic: "Epic",
  feature: "Feature",
};

/** A round's state word and its dot's tone. */
export function roundState(iteration: RunIterationView): { text: string; tone: StatusTone } {
  switch (iteration.status) {
    case "working":
      return { text: iteration.number > 1 ? "Revising" : "Drafting", tone: "run" };
    case "verifying":
      return { text: "Checking", tone: "run" };
    case "failed":
      return { text: "Failed", tone: "fail" };
    case "done":
      if (iteration.verdict === "converged") return { text: "Passed", tone: "good" };
      return iteration.outcome
        ? { text: "Still failing", tone: "warn" }
        : { text: "Sent back", tone: "warn" };
  }
}

const roundCount = (n: number) => (n === 1 ? "1 round" : `${n} rounds`);
const questionCount = (n: number) => (n === 1 ? "1 open question" : `${n} open questions`);

/** How the triage loop ended, from its last round's outcome; null while it runs. */
export function triageLoopEnding(iterations: readonly RunIterationView[]): string | null {
  const last = iterations.at(-1);
  if (!last?.outcome) return null;
  switch (last.outcome) {
    case "converged":
      return `The lint and the critic passed after ${roundCount(last.number)}.`;
    case "max-iterations":
      return `It stopped after ${roundCount(last.maxIterations)}, its cap, before the lint and the critic both passed.`;
    case "stalled":
      return `It stopped after ${roundCount(last.number)}: the draft stopped improving.`;
    case "failed":
      return `It stopped after ${roundCount(last.number)}: the last round failed.`;
  }
}

function RoundLint({ lint }: { lint: TriageRoundView["lint"] }) {
  return (
    <div className="or-verdict__text">
      <span className="or-verdict__label">Lint: </span>
      {lint.passed ? "passed" : "failed"}
      {lint.problems.length > 0 ? (
        <ul className="or-verdict__findings" aria-label="Lint problems">
          {lint.problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RoundCritique({ round, checking }: { round: TriageRoundView; checking: boolean }) {
  const { critique } = round;
  if (!critique) {
    const why = checking
      ? "checking…"
      : round.sizing?.size === "feature"
        ? "not run: a Feature's recommendation isn't judged"
        : round.sizing === null
          ? "not run: there was no usable draft"
          : "didn't answer";
    return (
      <p className="or-verdict__text">
        <span className="or-verdict__label">Critic: </span>
        {why}
      </p>
    );
  }
  return (
    <div className="or-verdict__text">
      <span className="or-verdict__label">Critic: </span>
      {critique.verdict === "pass" ? "pass" : "fail"}
      <ul className="or-verdict__findings" aria-label="Critic notes">
        {critique.notes.map((note, index) => (
          <li key={index}>
            <span className="or-mono">{note.item}</span> {note.ok ? "(met)" : "(not met)"}:{" "}
            {note.note}
          </li>
        ))}
      </ul>
      {critique.openQuestions.length > 0 ? (
        <>
          <span className="or-verdict__label">Critic questions</span>
          <ul className="or-verdict__findings" aria-label="Critic questions">
            {critique.openQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function RoundChanges({ round }: { round: TriageRoundView }) {
  if (!round.sizing) return null;
  const { changes } = round;
  if (!changes) return <p className="or-verdict__text">First draft.</p>;
  if (!changes.patch && !changes.truncated) {
    return <p className="or-verdict__text">{"The draft didn't change."}</p>;
  }
  return (
    <DiffView
      aria-label="Draft changes"
      className="or-triage-iterations__diff"
      files={[
        {
          path: "Changes to the draft",
          additions: changes.additions,
          deletions: changes.deletions,
          patch: changes.patch,
          truncated: changes.truncated,
        },
      ]}
    />
  );
}

function Round({ iteration }: { iteration: RunIterationView }) {
  const state = roundState(iteration);
  const round = iteration.triage;
  return (
    <li className="or-verdict__item">
      <StatusDot tone={state.tone} label={state.text} />
      <div className="or-verdict__body or-triage-iterations__round">
        <p className="or-verdict__name">
          Round {iteration.number} of {iteration.maxIterations}
          <span className="or-verdict__state">{state.text}</span>
        </p>
        {round ? (
          <>
            {round.sizing ? (
              <p className="or-verdict__text">
                <MetaBadge text={TRIAGE_SIZE_WORDS[round.sizing.size]} /> {round.title}
              </p>
            ) : null}
            <RoundLint lint={round.lint} />
            <RoundCritique round={round} checking={iteration.status === "verifying"} />
            <RoundChanges round={round} />
          </>
        ) : null}
        {iteration.error ? <p className="or-verdict__text">{iteration.error}</p> : null}
      </div>
    </li>
  );
}

export interface TriageIterationsProps {
  iterations: readonly RunIterationView[];
  /** The open questions the triage left on the work item. */
  openQuestions: readonly string[];
  /** Where the user answers them (the open questions form); no link without it. */
  answerHref?: string;
  /** The heading's element. */
  heading?: `h${1 | 2 | 3 | 4 | 5 | 6}`;
}

/**
 * A triage run's rounds, in order (the triage card's Iterations section): each one's state, the
 * draft's size and title, the work item lint's result, the plan critic's verdict and notes and
 * what changed in the draft since the previous round; then how the loop ended and, when it
 * stopped at its cap, the open questions it left for a person with a link to answer them.
 * Nothing for a triage that didn't loop.
 */
export function TriageIterations({
  iterations,
  openQuestions,
  answerHref,
  heading: Heading = "h4",
}: TriageIterationsProps) {
  const headingId = useId();
  if (iterations.length === 0) return null;
  const ending = triageLoopEnding(iterations);
  const capped = iterations.at(-1)?.outcome === "max-iterations";
  return (
    <section className="or-triage-iterations" aria-labelledby={headingId}>
      <Heading id={headingId} className="or-triage-summary__subtitle">
        Iterations
      </Heading>
      <ol className="or-verdict__items" aria-label="Iterations">
        {iterations.map((iteration) => (
          <Round key={iteration.id} iteration={iteration} />
        ))}
      </ol>
      {ending ? <p className="or-iterations__ending">{ending}</p> : null}
      {capped && openQuestions.length > 0 ? (
        <div className="or-triage-iterations__left">
          <p className="or-iterations__ending">
            What still failed is left as {questionCount(openQuestions.length)} for a person
            {answerHref ? (
              <>
                {": "}
                <TextLink href={answerHref}>Answer them</TextLink>
              </>
            ) : (
              "."
            )}
          </p>
          <ol className="or-triage-summary__list" aria-label="Open questions left at the cap">
            {openQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
