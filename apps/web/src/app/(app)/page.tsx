import { Suspense } from "react";
import { InboxUpNext } from "@/screens/backlog/up-next";
import { InboxView } from "@/screens/inbox/inbox-view";

/**
 * The home page: the Inbox, everything only a person can unblock (`src/screens/inbox`),
 * with the Backlog's Up next when nothing needs you.
 */
export default function InboxPage() {
  return (
    <Suspense>
      <InboxView upNext={<InboxUpNext />} />
    </Suspense>
  );
}
