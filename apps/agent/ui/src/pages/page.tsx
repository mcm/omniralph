/** A section page's frame: its back link, its heading (and toolbar), then its content. */
import type { ReactNode } from "react";

export interface AgentPageProps {
  title: string;
  /** The page's toolbar, at the top right (Design rule 5). */
  actions?: ReactNode;
  /** A back link to the page above, drawn above the heading. */
  back?: ReactNode;
  children?: ReactNode;
}

export function AgentPage({ title, actions, back, children }: AgentPageProps) {
  return (
    <div className="agent-section">
      {back}
      <header className="agent-section__head">
        <h2 className="agent-section__title">{title}</h2>
        {actions !== undefined ? <div className="agent-section__actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
