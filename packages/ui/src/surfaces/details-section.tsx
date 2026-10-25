import { IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";

export interface DetailsSectionProps {
  /** The summary line. Defaults to "Details". */
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Secondary facts behind a native disclosure (`<details>`), collapsed by default. */
export function DetailsSection({ title = "Details", className, children }: DetailsSectionProps) {
  return (
    <details className={["or-more-info", className].filter(Boolean).join(" ")}>
      <summary className="or-more-info__summary">
        <IconChevronRight
          className="or-more-info__chevron"
          size={14}
          stroke={2}
          aria-hidden="true"
        />
        {title}
      </summary>
      <div className="or-more-info__body">{children}</div>
    </details>
  );
}
