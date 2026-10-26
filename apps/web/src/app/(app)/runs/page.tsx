import { Suspense } from "react";
import { RunsView } from "@/screens/runs/runs-view";

/** Runs: every run of every kind, filterable by kind, status and repo (`src/screens/runs`). */
export default function RunsPage() {
  return (
    <Suspense>
      <RunsView />
    </Suspense>
  );
}
