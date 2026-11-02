import { DetailsSection, IssueBadge, Markdown, MetaBadge, StatusText } from "@omniralph/ui";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { WORK_ITEM_STATE_TONES } from "./state-tones";
import "./story-list.css";

export interface StoryListProps {
  tracker: WorkItemDetail["tracker"];
  stories: WorkItemDetail["stories"];
  /** The list's accessible name. Defaults to "Stories". */
  label?: string;
}

/**
 * A work item's stories (the Backlog detail's Stories tab, the View PRD sheet): each row's
 * identifier badge (linked when it has a URL), title, state and manual badge, and its content
 * behind a "Details" disclosure, collapsed by default (none when the content is empty).
 */
export function StoryList({ tracker, stories, label = "Stories" }: StoryListProps) {
  return (
    <ol className="or-story-list" aria-label={label}>
      {stories.map((story, index) => (
        <li key={story.identifier ?? `story-${index}`} className="or-story-list__story">
          {story.identifier ? (
            <IssueBadge tracker={tracker} id={story.identifier} href={story.url ?? undefined} />
          ) : null}
          <span className="or-story-list__title">{story.title}</span>
          {story.state ? (
            <StatusText tone={WORK_ITEM_STATE_TONES[story.state.category]}>
              {story.state.name}
            </StatusText>
          ) : null}
          {story.manual ? <MetaBadge text="manual" /> : null}
          {story.content.trim() ? (
            <DetailsSection className="or-story-list__details">
              <Markdown>{story.content}</Markdown>
            </DetailsSection>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
