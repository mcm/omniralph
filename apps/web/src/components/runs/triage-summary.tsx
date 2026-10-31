"use client";

import {
  Button,
  Card,
  DetailsSection,
  Markdown,
  MetaBadge,
  SizeBadge,
  StatusDot,
  type HeadingLevel,
  type StatusTone,
} from "@omniralph/ui";
import { IconFileText, IconListCheck } from "@tabler/icons-react";
import { useId } from "react";
import type { RunTriageSummary, TriageSummaryOutcome } from "@/lib/api/runs";
import { useRunTriage } from "./use-run-triage";
import "./triage-summary.css";

/** What each outcome reads as, and its dot's tone. */
export const TRIAGE_OUTCOME_VIEWS: Record<
  TriageSummaryOutcome,
  { label: string; tone: StatusTone }
> = {
  triaging: { label: "Triaging", tone: "run" },
  ready: { label: "Ready to start", tone: "good" },
  needs_answers: { label: "Needs answers", tone: "need" },
  failed: { label: "Triage failed", tone: "fail" },
  stopped: { label: "Stopped", tone: "warn" },
};

const CHANGE_LABELS: Record<NonNullable<RunTriageSummary["change"]>, string> = {
  prd: "New PRD",
  reformat: "Reformatted epic",
  unchanged: "PRD unchanged",
};

/** "1 story", "4 stories". */
const storiesText = (count: number) => (count === 1 ? "1 story" : `${count} stories`);

export interface TriageSummaryProps {
  runId: string;
  /** Opens the work item's PRD in a sheet; no View PRD button without it. */
  onViewPrd?: () => void;
  headingLevel?: HeadingLevel;
}

/**
 * A triage run's card in its detail: the outcome (still triaging, Ready to start, Needs
 * answers, failed or stopped) with what triage did (a new PRD, a reformatted epic or none),
 * the size and planned stories; Om's summary or why it failed; the open questions it left;
 * and, collapsed, the issue as it read before triage. View PRD opens the PRD in a sheet.
 * Nothing while it loads or when it can't be loaded (the run's Activity still shows it).
 */
export function TriageSummary({ runId, onViewPrd, headingLevel = 3 }: TriageSummaryProps) {
  const triage = useRunTriage(runId);
  const questionsId = useId();
  if (!triage.data) return null;
  const summary = triage.data;
  const view = TRIAGE_OUTCOME_VIEWS[summary.outcome];
  const sub = headingLevel < 4 ? ((headingLevel + 1) as HeadingLevel) : 4;
  const SubHeading = `h${sub}` as const;
  return (
    <Card
      title="Triage"
      headingLevel={headingLevel}
      className="or-triage-summary"
      actions={
        onViewPrd ? (
          <Button variant="outline" size="sm" icon={IconFileText} onClick={onViewPrd}>
            View PRD
          </Button>
        ) : undefined
      }
    >
      <div className="or-triage-summary__outcome">
        <StatusDot tone={view.tone} label={view.label} />
        <span className="or-triage-summary__label">{view.label}</span>
        {summary.change ? <MetaBadge text={CHANGE_LABELS[summary.change]} /> : null}
        {summary.size ? <SizeBadge size={summary.size} /> : null}
        {summary.storyCount > 0 ? (
          <MetaBadge icon={IconListCheck} text={storiesText(summary.storyCount)} />
        ) : null}
      </div>
      {summary.error ? (
        <pre className="or-triage-summary__error">{summary.error}</pre>
      ) : summary.summary && summary.outcome !== "triaging" ? (
        <Markdown className="or-triage-summary__text">{summary.summary}</Markdown>
      ) : null}
      {summary.openQuestions.length > 0 && summary.outcome !== "triaging" ? (
        <section className="or-triage-summary__questions" aria-labelledby={questionsId}>
          <SubHeading id={questionsId} className="or-triage-summary__subtitle">
            Open questions
          </SubHeading>
          <ol className="or-triage-summary__list">
            {summary.openQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ol>
        </section>
      ) : null}
      {summary.originalIssue ? (
        <DetailsSection title="Original issue" className="or-triage-summary__original">
          <p className="or-triage-summary__original-title">{summary.originalIssue.title}</p>
          {summary.originalIssue.description.trim() ? (
            <Markdown>{summary.originalIssue.description}</Markdown>
          ) : (
            <p className="or-triage-summary__empty">The issue had no description.</p>
          )}
        </DetailsSection>
      ) : null}
    </Card>
  );
}
