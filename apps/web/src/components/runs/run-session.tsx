"use client";

import { activityDate, Button, DetailsSection, IssueBadge, RepoBadge } from "@omniralph/ui";
import { useId, type ReactNode } from "react";
import type { RunDetail, RunSession as RunSessionData } from "@/lib/api/runs";
import {
  mergeSessionPages,
  RUN_MESSAGE_KIND_LABELS,
  RUN_MESSAGE_STATE_LABELS,
  SESSION_SECTION_TITLES,
  sessionSections,
  type SessionSection,
} from "./session";
import { useRunSession } from "./use-run-session";
import "./run-session.css";

/** The run kinds that have a Session. */
export function hasSession(run: Pick<RunDetail, "kind">): boolean {
  return run.kind === "epic" || run.kind === "request";
}

function Time({ at }: { at: string }) {
  return (
    <time className="or-mono" dateTime={at}>
      {activityDate(at)}
    </time>
  );
}

/** A list entry: the text, then a line of facts about it. */
function Entry({ text, meta }: { text: ReactNode; meta: ReactNode }) {
  return (
    <li className="or-run-session__entry">
      <div className="or-run-session__text">{text}</div>
      <div className="or-run-session__meta">{meta}</div>
    </li>
  );
}

function PendingRequests({ session }: { session: RunSessionData }) {
  return (
    <ul className="or-run-session__list">
      {session.pendingRequests.map((request) => (
        <Entry
          key={request.id}
          text={request.text}
          meta={
            <>
              {request.author ? <span>{request.author}</span> : null}
              {request.repository ? (
                <RepoBadge host={request.repository.provider} name={request.repository.fullPath} />
              ) : null}
              <Time at={request.createdAt} />
            </>
          }
        />
      ))}
    </ul>
  );
}

function Messages({
  session,
  more,
}: {
  session: RunSessionData;
  more: { show: boolean; loading: boolean; load: () => void };
}) {
  return (
    <>
      <ul className="or-run-session__list">
        {session.messages.map((message) => (
          <Entry
            key={message.id}
            text={message.text}
            meta={
              <>
                <span>{RUN_MESSAGE_KIND_LABELS[message.kind]}</span>
                {message.author ? <span>{message.author}</span> : null}
                <span>For: {message.attempt.label}</span>
                <Time at={message.createdAt} />
                <span className="or-run-session__state">
                  {RUN_MESSAGE_STATE_LABELS[message.state]}
                  {message.settledAt ? (
                    <>
                      {" "}
                      <Time at={message.settledAt} />
                    </>
                  ) : null}
                </span>
              </>
            }
          />
        ))}
      </ul>
      {more.show ? (
        <Button
          variant="ghost"
          size="sm"
          className="or-run-session__more"
          disabled={more.loading}
          onClick={more.load}
        >
          Show older messages
        </Button>
      ) : null}
    </>
  );
}

function Guidance({ session }: { session: RunSessionData }) {
  return (
    <ul className="or-run-session__list">
      {session.guidance.map((guidance, index) => (
        <Entry
          key={`${guidance.at}-${index}`}
          text={guidance.text}
          meta={<Time at={guidance.at} />}
        />
      ))}
    </ul>
  );
}

function Recommendations({ session }: { session: RunSessionData }) {
  return (
    <ul className="or-run-session__list">
      {session.recommendations.map((recommendation) => (
        <Entry
          key={`${recommendation.story.id}-${recommendation.title}`}
          text={
            <>
              <strong className="or-run-session__title">{recommendation.title}</strong>
              {recommendation.description ? <span>{recommendation.description}</span> : null}
            </>
          }
          meta={
            <>
              <IssueBadge
                tracker="linear"
                id={recommendation.story.identifier}
                href={recommendation.story.url ?? undefined}
              />
              <span>{recommendation.story.title}</span>
              <Time at={recommendation.at} />
            </>
          }
        />
      ))}
    </ul>
  );
}

/**
 * The run detail's Session section for an epic or request (collapsed, Design rule 16): its
 * pending requests, the messages passed to its attempts (older ones on demand), its
 * guidance, Om's recommendations and the progress log. Empty subsections are left out, and
 * the section is left out when every one is empty (or while it loads). A live query.
 */
export function RunSession({ run }: { run: Pick<RunDetail, "id" | "kind"> }) {
  const id = useId();
  const query = useRunSession(run.id, { enabled: hasSession(run) });
  if (!hasSession(run) || query.isPending) return null;
  if (query.isError) {
    return (
      <DetailsSection title="Session" className="or-run-session">
        <p className="or-run-error" role="alert">
          Couldn&apos;t load the session.
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </p>
      </DetailsSection>
    );
  }
  const session = mergeSessionPages(query.data.pages);
  const sections = session ? sessionSections(session) : [];
  if (!session || sections.length === 0) return null;

  const body: Record<SessionSection, () => ReactNode> = {
    pendingRequests: () => <PendingRequests session={session} />,
    messages: () => (
      <Messages
        session={session}
        more={{
          show: query.hasNextPage,
          loading: query.isFetchingNextPage,
          load: () => void query.fetchNextPage(),
        }}
      />
    ),
    guidance: () => <Guidance session={session} />,
    recommendations: () => <Recommendations session={session} />,
    progressLog: () => <pre className="or-run-session__log or-mono">{session.progressLog}</pre>,
  };
  return (
    <DetailsSection title="Session" className="or-run-session">
      {sections.map((section) => (
        <section
          key={section}
          className="or-run-session__section"
          aria-labelledby={`${id}-${section}`}
        >
          <h4 id={`${id}-${section}`} className="or-run-session__heading">
            {SESSION_SECTION_TITLES[section]}
          </h4>
          {body[section]()}
        </section>
      ))}
    </DetailsSection>
  );
}
