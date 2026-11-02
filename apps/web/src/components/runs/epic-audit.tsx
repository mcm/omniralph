"use client";

import { IssueBadge, StatusDot, type StatusTone } from "@omniralph/ui";
import type { RunDetail, RunStep } from "@/lib/api/runs";
import type { StepPanelTab } from "./step-panel";
import "./loop-views.css";

type AuditStep = Extract<RunStep, { kind: "audit" }>;

/** The audit step panel's tab, shown first. */
export const STEP_PANEL_REQUIREMENTS = "requirements";

/** What an audit round reads as, and its dot's tone. */
export function auditHeadline(step: AuditStep): { text: string; tone: StatusTone } {
  const gaps = step.requirements.filter((r) => r.status === "gap").length;
  switch (step.status) {
    case "running":
      return { text: "Om is checking each requirement against the code", tone: "run" };
    case "passed":
      return { text: "Every requirement is met", tone: "good" };
    case "gaps":
      return {
        text:
          step.filed.length > 0
            ? `${gaps} ${gaps === 1 ? "requirement isn't" : "requirements aren't"} met yet: Om filed ${
                step.filed.length === 1 ? "a task" : `${step.filed.length} tasks`
              } to close ${gaps === 1 ? "it" : "them"}`
            : `${gaps} ${gaps === 1 ? "requirement isn't" : "requirements aren't"} met, and the audit rounds ran out: the description lists ${
                gaps === 1 ? "it" : "them"
              } as remaining gaps`,
        tone: "warn",
      };
    case "failed":
      return {
        text: "The audit couldn't check the epic, so Om went ahead without it",
        tone: "fail",
      };
    case "skipped":
      return {
        text: "The epic lists no requirements, so there was nothing to audit",
        tone: "neutral",
      };
  }
}

/**
 * An epic audit round: a headline (checking, all met, gaps filed or listed, couldn't audit,
 * nothing to audit), its summary or why it failed, each requirement with the evidence that it's
 * met or what is missing, and links to the tasks it filed for its gaps.
 */
export function EpicAudit({ step }: { step: AuditStep }) {
  const headline = auditHeadline(step);
  return (
    <section className="or-verdict" aria-label="Epic audit">
      <p className="or-verdict__headline">
        <StatusDot tone={headline.tone} label={headline.text} />
        <span>{headline.text}</span>
      </p>
      {step.error ? (
        <p className="or-verdict__text">{step.error}</p>
      ) : step.summary ? (
        <p className="or-verdict__text">{step.summary}</p>
      ) : null}
      {step.requirements.length > 0 ? (
        <ul className="or-verdict__items" aria-label="Requirements">
          {step.requirements.map((requirement) => {
            const met = requirement.status === "met";
            return (
              <li key={requirement.id} className="or-verdict__item">
                <StatusDot tone={met ? "good" : "fail"} label={met ? "Met" : "Gap"} />
                <div className="or-verdict__body">
                  <p className="or-verdict__name">
                    <span className="or-mono">{requirement.id}</span> {requirement.text}
                    <span className="or-verdict__state">{met ? "Met" : "Gap"}</span>
                  </p>
                  {requirement.evidence ? (
                    <p className="or-verdict__text">
                      <span className="or-verdict__label">Evidence: </span>
                      {requirement.evidence}
                    </p>
                  ) : null}
                  {!met && requirement.missing ? (
                    <p className="or-verdict__text">
                      <span className="or-verdict__label">Missing: </span>
                      {requirement.missing}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {step.filed.length > 0 ? (
        <div className="or-verdict__filed">
          <span className="or-verdict__label">Tasks filed</span>
          {step.filed.map((task) => (
            <IssueBadge
              key={task.identifier}
              tracker={task.tracker}
              id={task.identifier}
              href={task.url ?? undefined}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The Requirements tab of an epic's audit step, shown first; none for other steps. */
export function epicAuditTabs(_run: RunDetail, step: RunStep): StepPanelTab[] {
  if (step.kind !== "audit") return [];
  return [
    {
      value: STEP_PANEL_REQUIREMENTS,
      label: "Requirements",
      count: step.requirements.length,
      content: <EpicAudit step={step} />,
      first: true,
    },
  ];
}
