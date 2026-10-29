export interface ListLoadingProps {
  /** Read out while the list loads, e.g. "Loading the Inbox". */
  label: string;
  /** How many placeholder rows to draw; defaults to 5. */
  rows?: number;
  className?: string;
}

/**
 * The one loading state of a list pane: placeholder rows shaped like `ListRow`s (a dot, a
 * short kind line and a title line) in place of the rows, so the pane is never blank while
 * its query loads. It is a busy `status` whose text is `label`; the placeholders are hidden
 * from assistive technology. Static: no shimmer.
 */
export function ListLoading({ label, rows = 5, className }: ListLoadingProps) {
  return (
    <div
      className={["or-list-loading", className].filter(Boolean).join(" ")}
      role="status"
      aria-busy="true"
    >
      <span className="or-sr-only">{label}</span>
      <div className="or-list-loading__rows" aria-hidden="true">
        {Array.from({ length: Math.max(1, rows) }, (_, index) => (
          <div key={index} className="or-list-loading__row">
            <span className="or-list-loading__dot" />
            <span className="or-list-loading__lines">
              <span className="or-list-loading__line or-list-loading__line--short" />
              <span className="or-list-loading__line" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
