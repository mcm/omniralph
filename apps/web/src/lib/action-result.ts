/** Result of a mutating server action, shown to the user as a toast. */
export type ActionResult = { ok: true } | { ok: false; error: string };
