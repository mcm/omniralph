import "./backlog.css";

/** What assistive tech hears while the Backlog's list loads. */
export const LOADING_BACKLOG = "Loading work items…";

/** What assistive tech hears while a work item loads. */
export const LOADING_WORK_ITEM = "Loading the work item…";

/** Placeholder rows, as many as a short backlog shows; widths vary so they read as rows. */
const ROW_WIDTHS = ["72%", "58%", "80%", "64%", "48%", "70%"];

/**
 * The Backlog list while it loads (from Linear it can take a second): a group heading and
 * rows shaped like `ListRow`s (a mark, a title line and a badge line), not an empty pane.
 */
export function BacklogListSkeleton() {
  return (
    <div className="or-backlog-skeleton" role="status" data-testid="backlog-skeleton">
      <span className="or-sr-only">{LOADING_BACKLOG}</span>
      <div aria-hidden="true">
        <div className="or-backlog-skeleton__heading" />
        {ROW_WIDTHS.map((width, index) => (
          <div key={index} className="or-backlog-skeleton__row">
            <div className="or-backlog-skeleton__mark" />
            <div className="or-backlog-skeleton__lines">
              <div className="or-backlog-skeleton__line" style={{ width }} />
              <div className="or-backlog-skeleton__line or-backlog-skeleton__line--meta" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A work item while it loads: the bar's badges, the title, the tab strip and a few lines of
 * PRD, where the loaded item draws them.
 */
export function WorkItemDetailSkeleton() {
  return (
    <div
      className="or-backlog-detail or-backlog-skeleton"
      role="status"
      aria-busy="true"
      data-testid="work-item-skeleton"
    >
      <span className="or-sr-only">{LOADING_WORK_ITEM}</span>
      <div className="or-backlog-skeleton__detail" aria-hidden="true">
        <div className="or-backlog-skeleton__badges">
          <div className="or-backlog-skeleton__badge" />
          <div className="or-backlog-skeleton__badge" />
        </div>
        <div className="or-backlog-skeleton__title" />
        <div className="or-backlog-skeleton__tabs" />
        <div className="or-backlog-skeleton__line" />
        <div className="or-backlog-skeleton__line" />
        <div className="or-backlog-skeleton__line or-backlog-skeleton__line--short" />
      </div>
    </div>
  );
}
