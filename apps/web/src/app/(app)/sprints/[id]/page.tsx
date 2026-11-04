import { Suspense } from "react";
import { SprintsView } from "@/screens/sprints/sprints-view";

/** A sprint beside the Sprints list (`src/screens/sprints`). */
export default async function SprintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <SprintsView sprintId={id} />
    </Suspense>
  );
}
