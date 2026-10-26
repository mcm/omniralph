"use client";

import { FEEDBACK_REASON_LABELS } from "@omniralph/shared";
import { activityDate, Button, TextLink } from "@omniralph/ui";
import { IconFileCode } from "@tabler/icons-react";
import type {
  ReviewFindingFile,
  ReviewFindingView,
  ReviewPassFindings,
  RunDetail,
  RunStep,
} from "@/lib/api/runs";
import { NO_RUN_FILTERS, runInListHref } from "@/screens/runs/filters";
import {
  FINDING_SEVERITY_LABELS,
  FINDING_STATUS_LABELS,
  findingFacts,
  lineRange,
  noFindingsText,
  openFindingsTotal,
} from "./findings";
import type { StepPanelTab } from "./step-panel";
import { useRunFindings } from "./use-run-findings";
import "./review-findings.css";

/** The step panel's Findings tab (`?tab=findings`). */
export const STEP_PANEL_FINDINGS = "findings";

/** The failed load of a run's findings, when the server gives no reason. */
export const FINDINGS_FAILED = "Couldn't load the findings.";

type ReviewPassStep = Extract<RunStep, { kind: "review_pass" }>;

function Time({ at }: { at: string }) {
  return (
    <time className="or-mono" dateTime={at}>
      {activityDate(at)}
    </time>
  );
}

/** A finding's dismissals, oldest first, read-only. */
function FindingFeedback({ feedback }: { feedback: ReviewFindingView["feedback"] }) {
  if (feedback.length === 0) return null;
  return (
    <ul className="or-finding__feedback">
      {feedback.map((entry) => (
        <li key={entry.id}>
          <span>
            Dismissed by {entry.actor} · {FEEDBACK_REASON_LABELS[entry.reason]} ·{" "}
            <Time at={entry.createdAt} />
          </span>
          {entry.note ? <q className="or-finding__note">{entry.note}</q> : null}
          {entry.restoredAt ? (
            <span>
              Restored by {entry.restoredBy} · <Time at={entry.restoredAt} />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FindingItem({ finding }: { finding: ReviewFindingView }) {
  const { supersededBy } = finding;
  return (
    <li
      id={`finding-${finding.id}`}
      className="or-finding"
      data-inactive={finding.status !== "open" || undefined}
    >
      <h5 className="or-finding__title">{finding.title}</h5>
      <div className="or-finding__meta">
        <span className="or-finding__severity">{FINDING_SEVERITY_LABELS[finding.severity]}</span>
        <span className="or-mono">{lineRange(finding)}</span>
        <span>{findingFacts(finding)}</span>
        {finding.status !== "open" ? (
          <span className="or-finding__status">{FINDING_STATUS_LABELS[finding.status]}</span>
        ) : null}
      </div>
      <p className="or-finding__body">{finding.body}</p>
      {finding.suggestion !== null ? (
        <div className="or-finding__suggestion">
          <span className="or-finding__label">Suggested change</span>
          <pre className="or-finding__code">{finding.suggestion}</pre>
        </div>
      ) : null}
      {supersededBy ? (
        <p className="or-finding__superseded">
          Superseded by{" "}
          <TextLink
            href={`${runInListHref(supersededBy.runId, NO_RUN_FILTERS, {
              step: supersededBy.stepId,
              tab: STEP_PANEL_FINDINGS,
            })}#finding-${supersededBy.findingId}`}
          >
            a finding of a later review
          </TextLink>
          .
        </p>
      ) : null}
      <FindingFeedback feedback={finding.feedback} />
    </li>
  );
}

function FileFindings({ file }: { file: ReviewFindingFile }) {
  const count = file.findings.length;
  return (
    <section className="or-findings__file" aria-label={file.path}>
      <h4 className="or-findings__path">
        <IconFileCode size={14} aria-hidden="true" />
        <span className="or-mono or-findings__path-text" title={file.path}>
          {file.path}
        </span>
        <span className="or-findings__count">
          {count} {count === 1 ? "finding" : "findings"}
        </span>
      </h4>
      <ul className="or-findings__list">
        {file.findings.map((finding) => (
          <FindingItem key={finding.id} finding={finding} />
        ))}
      </ul>
    </section>
  );
}

function SkippedFiles({ files }: { files: ReviewPassFindings["skippedFiles"] }) {
  if (files.length === 0) return null;
  return (
    <section className="or-findings__skipped" aria-label="Skipped files">
      <h4 className="or-findings__heading">
        {files.length} {files.length === 1 ? "file wasn't" : "files weren't"} reviewed
      </h4>
      <ul className="or-findings__skipped-list">
        {files.map((file) => (
          <li key={file.path}>
            <span className="or-mono">{file.path}</span>
            <span className="or-findings__reason">{file.reason.replaceAll("_", " ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A review pass's findings, read-only: grouped by file (files in the order of their first
 * finding, findings by line), each with its severity, lines, category and confidence, the
 * suggested change, a link to the finding that superseded it and its dismissals; then the
 * files the pass skipped. Loaded once per run (every pass's findings), refetched by the
 * run's change events.
 */
export function ReviewFindingsView({ runId, step }: { runId: string; step: ReviewPassStep }) {
  const findings = useRunFindings(runId);
  if (findings.isPending) {
    return (
      <div className="or-step-panel__loading" aria-busy="true" data-testid="findings-skeleton">
        <div className="or-run-skeleton__line" />
        <div className="or-run-skeleton__line or-run-skeleton__line--short" />
      </div>
    );
  }
  if (findings.isError) {
    return (
      <p className="or-run-error" role="alert">
        {findings.error.message || FINDINGS_FAILED}
        <Button
          variant="outline"
          size="sm"
          disabled={findings.isFetching}
          onClick={() => void findings.refetch()}
        >
          Retry
        </Button>
      </p>
    );
  }
  const pass = findings.data.passes.find((p) => p.id === step.id);
  const files = pass?.files ?? [];
  return (
    <div className="or-findings">
      {files.length === 0 ? (
        <p className="or-step-panel__empty">{noFindingsText(pass?.status ?? step.status)}</p>
      ) : (
        files.map((file) => <FileFindings key={file.path} file={file} />)
      )}
      <SkippedFiles files={pass?.skippedFiles ?? []} />
    </div>
  );
}

/** The Findings tab for a review run's pass, counting its open findings; none for other steps. */
export function reviewFindingsTabs(run: RunDetail, step: RunStep): StepPanelTab[] {
  if (run.kind !== "review" || step.kind !== "review_pass") return [];
  return [
    {
      value: STEP_PANEL_FINDINGS,
      label: "Findings",
      count: openFindingsTotal(step),
      content: <ReviewFindingsView runId={run.id} step={step} />,
    },
  ];
}
