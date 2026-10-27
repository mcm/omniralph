"use client";

import { AppFrame } from "@omniralph/ui";
import type { ComponentProps } from "react";
import { withNavIndicators } from "@/lib/navigation";
import { useBacklogCounts } from "@/screens/backlog/queries";
import { useInboxCounts } from "@/screens/inbox/queries";
import { useNavIndicators } from "@/screens/nav-indicators";

/**
 * `AppFrame` with the nav's live indicators: the Inbox's needs-you count and the Runs dot,
 * from the Inbox counts (a live query the Inbox's tabs share through the cache), the
 * Backlog's neutral count, from the Backlog counts (a live query too), and the Fleet and
 * Settings dots, from the nav indicators (shared with Settings' section nav). The
 * frame draws them on the sidebar, the icon rail and the phone drawer and its hamburger.
 */
export function LiveAppFrame({ nav, ...props }: ComponentProps<typeof AppFrame>) {
  const counts = useInboxCounts();
  const backlog = useBacklogCounts();
  const indicators = useNavIndicators();
  return (
    <AppFrame
      {...props}
      nav={withNavIndicators(nav, counts.data, backlog.data, indicators.data)}
    />
  );
}
