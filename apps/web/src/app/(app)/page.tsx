import { Suspense } from "react";
import { InboxView } from "@/screens/inbox/inbox-view";

/** The home page: the Inbox, everything only a person can unblock (`src/screens/inbox`). */
export default function InboxPage() {
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}
