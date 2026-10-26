import { Suspense } from "react";
import { RunsView } from "@/screens/runs/runs-view";

/** A run of any kind beside the Runs rail (`src/screens/runs`). */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <RunsView runId={id} />
    </Suspense>
  );
}
