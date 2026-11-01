import { EmptyState, IssueBadge, Markdown, MetaBadge } from "@omniralph/ui";
import { IconLinkOff } from "@tabler/icons-react";
import { trackerLabel } from "@/lib/api/trackers";
import { formatShareExpiry } from "@/lib/work-items/share-expiry";
import { SHARE_LINK_GONE_MESSAGE } from "@/lib/work-items/share-links";
import type { SharedWorkItemPage } from "@/lib/work-items/share-page";
import { SharePasswordForm } from "./share-password-form";

/** The review page for each state of its link. Links only to the PRD's own external links. */
export function ShareView({ token, page }: { token: string; page: SharedWorkItemPage }) {
  switch (page.kind) {
    case "gone":
      return (
        <div className="or-card auth-card">
          <EmptyState title={SHARE_LINK_GONE_MESSAGE} headingLevel={1} icon={IconLinkOff} />
        </div>
      );
    case "unavailable":
      return (
        <div className="or-card auth-card">
          <EmptyState
            title={`Couldn't load this work item from ${trackerLabel(page.tracker)}.`}
            headingLevel={1}
            description="Try again in a moment."
          />
        </div>
      );
    case "locked":
      return <SharePasswordForm token={token} />;
    case "open":
      return (
        <article className="share-page">
          <header className="share-head">
            <IssueBadge tracker={page.tracker} id={page.identifier} />
            <h1 className="share-title">{page.title}</h1>
          </header>
          <div className="share-prd">
            {page.description.trim() ? (
              <Markdown>{page.description}</Markdown>
            ) : (
              <p className="share-muted">This work item has no PRD yet.</p>
            )}
          </div>
          {page.stories.length > 0 ? (
            <section className="share-stories" aria-labelledby="share-stories-title">
              <h2 id="share-stories-title">Stories · {page.stories.length}</h2>
              <ul>
                {page.stories.map((story, index) => (
                  <li key={story.identifier ?? `story-${index}`} className="share-story">
                    {story.identifier ? (
                      <IssueBadge tracker={page.tracker} id={story.identifier} />
                    ) : null}
                    <span className="share-story-title">{story.title}</span>
                    {story.state ? <span className="share-muted">{story.state}</span> : null}
                    {story.manual ? <MetaBadge text="manual" /> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="share-footer">
            {page.sharedBy ? `Shared by ${page.sharedBy} · ` : ""}expires{" "}
            {formatShareExpiry(page.expiresAt)}
          </p>
        </article>
      );
  }
}
