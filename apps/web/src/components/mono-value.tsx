import { cn } from "@iamthemcmaster/ui";

/** Longest tail kept whole when a value truncates in the middle (a file name, an ID suffix). */
const MAX_TAIL = 24;
/** Tail kept for values with no path or ref separator. */
const DEFAULT_TAIL = 6;

/**
 * The part of `value` that stays visible when it truncates in the middle:
 * from the last `/`, `!`, `#`, `@` or `:` (a file name, an MR/PR number, a
 * ref), else its last few characters. A PR/MR number keeps its repository name
 * (`…/control-panel#307`) when that fits.
 */
export function monoValueTail(value: string): string {
  const cut = Math.max(...["/", "!", "#", "@", ":"].map((sep) => value.lastIndexOf(sep)));
  if (cut > 0 && /^[#!]\d+$/.test(value.slice(cut))) {
    const repo = value.lastIndexOf("/", cut);
    if (repo > 0 && value.length - repo <= MAX_TAIL) return value.slice(repo);
  }
  if (cut > 0 && value.length - cut <= MAX_TAIL) return value.slice(cut);
  return value.length > DEFAULT_TAIL * 2 ? value.slice(-DEFAULT_TAIL) : "";
}

/**
 * An identifier, path, ref or ID in mono on one line (DESIGN.md's Exact Values
 * Rule). When its container is narrower it truncates in the middle (keeping
 * the tail from `monoValueTail`) or at the end; the full value is in `title`
 * and in the copied text.
 */
export function MonoValue({
  value,
  truncate = "middle",
  title = value,
  className,
}: {
  value: string;
  truncate?: "middle" | "end";
  /** The full value when `value` is already a short form (e.g. `shortJobId`). */
  title?: string;
  className?: string;
}) {
  const tail = truncate === "middle" ? monoValueTail(value) : "";
  const head = value.slice(0, value.length - tail.length);
  return (
    <span className={cn("mono-value text-numeric", className)} title={title}>
      <span className="mono-value-head">{head}</span>
      {tail && <span className="mono-value-tail">{tail}</span>}
    </span>
  );
}
