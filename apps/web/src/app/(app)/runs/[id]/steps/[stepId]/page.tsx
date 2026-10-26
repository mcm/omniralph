import { Suspense } from "react";
import { RunStepView } from "@/screens/runs/run-step-view";

/** A step of a run as its own view, the shared step panel at full width (`src/screens/runs`). */
export default async function RunStepPage({
  params,
}: {
  params: Promise<{ id: string; stepId: string }>;
}) {
  const { id, stepId } = await params;
  return (
    <Suspense>
      <RunStepView runId={id} stepId={stepId} />
    </Suspense>
  );
}
