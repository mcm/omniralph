import type { ReactNode } from "react";
import { Cluster, H1, cn } from "@iamthemcmaster/ui";

interface PageHeaderProps {
  /** The page's single `<h1>`. */
  title: ReactNode;
  /** One or two sentences under the title. Rendered in a `<p>`: pass inline content only. */
  description?: ReactNode;
  /** Badges and links that describe the page's subject (state, repository, version). */
  meta?: ReactNode;
  /** Page-level buttons. Right of the title on wide screens; they wrap below it on narrow ones. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The top of every page under `src/app/(app)`: the h1 title, an optional description and
 * meta row, and actions. Card and alert titles below it start at h2.
 */
export function PageHeader({ title, description, meta, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("page-header", className)}>
      <div className="page-header-text">
        <H1 className="page-header-title">{title}</H1>
        {description && <p className="page-header-description">{description}</p>}
        {meta && (
          <Cluster gap={2} className="page-header-meta">
            {meta}
          </Cluster>
        )}
      </div>
      {actions && (
        <Cluster gap={2} className="page-header-actions">
          {actions}
        </Cluster>
      )}
    </header>
  );
}
