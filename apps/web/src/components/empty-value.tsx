/**
 * The "—" of an empty cell or fact. Screen readers hear `label` ("none")
 * instead of "em dash". A `<span>`, so it is valid inside a `<p>`.
 */
export function EmptyValue({ label = "none" }: { label?: string }) {
  return (
    <span className="empty-value">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
