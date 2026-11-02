"use client";

import { StatusDot, type StatusTone } from "@omniralph/ui";
import type { AttemptVerification } from "@/lib/api/runs";
import "./loop-views.css";

/** What the task verifier's check of an attempt reads as, and its dot's tone. */
export function verdictHeadline(verification: AttemptVerification): {
  text: string;
  tone: StatusTone;
} {
  const { criteria } = verification;
  switch (verification.status) {
    case "running":
      return { text: "The verifier is checking its acceptance criteria", tone: "run" };
    case "accepted":
      return {
        text:
          criteria.length === 1
            ? "The verifier accepted its acceptance criterion"
            : criteria.length > 1
              ? `The verifier accepted all ${criteria.length} acceptance criteria`
              : "The verifier accepted it",
        tone: "good",
      };
    case "rejected": {
      const rejected = criteria.filter((c) => !c.accepted).length;
      return {
        text:
          rejected > 0
            ? `The verifier sent it back: ${rejected} of ${criteria.length} ${
                criteria.length === 1 ? "criterion" : "criteria"
              } not met`
            : "The verifier sent it back",
        tone: "fail",
      };
    }
    case "failed":
      return { text: "The verifier couldn't check it, so it counts as done", tone: "warn" };
  }
}

export interface AttemptVerdictProps {
  verification: AttemptVerification;
  className?: string;
}

/**
 * The task verifier's verdict on a story attempt: a headline (checking, accepted, sent back
 * or couldn't check), its summary or why it couldn't check, and each acceptance criterion
 * with whether it was accepted and why.
 */
export function AttemptVerdict({ verification, className }: AttemptVerdictProps) {
  const headline = verdictHeadline(verification);
  return (
    <section
      className={["or-verdict", className].filter(Boolean).join(" ")}
      aria-label="Verifier's verdict"
    >
      <p className="or-verdict__headline">
        <StatusDot tone={headline.tone} label={headline.text} />
        <span>{headline.text}</span>
      </p>
      {verification.error ? (
        <p className="or-verdict__text">{verification.error}</p>
      ) : verification.summary ? (
        <p className="or-verdict__text">{verification.summary}</p>
      ) : null}
      {verification.criteria.length > 0 ? (
        <ul className="or-verdict__items" aria-label="Acceptance criteria">
          {verification.criteria.map((item, index) => (
            <li key={index} className="or-verdict__item">
              <StatusDot
                tone={item.accepted ? "good" : "fail"}
                label={item.accepted ? "Accepted" : "Rejected"}
              />
              <div className="or-verdict__body">
                <p className="or-verdict__name">
                  {item.criterion}
                  <span className="or-verdict__state">
                    {item.accepted ? "Accepted" : "Rejected"}
                  </span>
                </p>
                {item.reason ? <p className="or-verdict__text">{item.reason}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
