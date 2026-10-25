"use client";

import { createContext, useContext, useId } from "react";

/** What a `Field` tells the control inside it: its id and the description to link. */
export type FieldContextValue = {
  controlId: string;
  descriptionId?: string;
};

export const FieldContext = createContext<FieldContextValue | null>(null);

/** Joins the ids that describe a control, skipping empty ones. */
export function joinIds(...ids: (string | undefined | null | false)[]): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}

/**
 * The id, `aria-describedby` and `aria-invalid` of a field control. The id comes from the
 * prop, else the surrounding `Field` (so its `<label for>` names the control), else
 * `useId()`. The description is the Field's, then the error message's, then the caller's.
 */
export function useControlIds(options: {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  hasError: boolean;
}) {
  const field = useContext(FieldContext);
  const generatedId = useId();
  const id = options.id ?? field?.controlId ?? generatedId;
  const errorId = `${id}-error`;
  return {
    id,
    errorId,
    describedBy: joinIds(field?.descriptionId, options.hasError && errorId, options.describedBy),
    invalid: (options.invalid ?? options.hasError) || undefined,
  };
}
