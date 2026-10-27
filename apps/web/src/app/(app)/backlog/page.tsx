import { Suspense } from "react";
import { BacklogView } from "@/screens/backlog/backlog-view";

/** Backlog: work that routes to a repo and hasn't started, by group (`src/screens/backlog`). */
export default function BacklogPage() {
  return (
    <Suspense>
      <BacklogView />
    </Suspense>
  );
}
