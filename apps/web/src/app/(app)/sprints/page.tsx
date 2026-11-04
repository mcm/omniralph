import { Suspense } from "react";
import { SprintsView } from "@/screens/sprints/sprints-view";

/** Sprints: ordered queues of epics, by repo (`src/screens/sprints`). */
export default function SprintsPage() {
  return (
    <Suspense>
      <SprintsView />
    </Suspense>
  );
}
