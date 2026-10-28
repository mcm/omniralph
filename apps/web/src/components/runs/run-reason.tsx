import { TextLink } from "@omniralph/ui";
import type { ReasonLink } from "@/lib/api/runs";

/**
 * A run's or Inbox item's reason (`runReason`): its sentence, then the link to where its
 * problem is fixed when it has one ("Open Fleet" for a missing host tool).
 */
export function RunReason({
  reason,
  link,
  className,
}: {
  reason: string;
  link: ReasonLink | null;
  className: string;
}) {
  return (
    <p className={className}>
      {reason}
      {link ? (
        <>
          {". "}
          <TextLink href={link.href}>{link.label}</TextLink>
        </>
      ) : null}
    </p>
  );
}
