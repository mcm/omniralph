import type { ReactNode } from "react";

/** The error under a control; its id is in the control's `aria-describedby`. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="or-field-error">
      {children}
    </p>
  );
}
