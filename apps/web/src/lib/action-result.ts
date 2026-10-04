/** Result of a mutating server action, shown to the user as a toast. */
export type ActionResult =
  | { ok: true; /** Shown instead of the default success toast, as a warning. */ warning?: string }
  | { ok: false; error: string };
