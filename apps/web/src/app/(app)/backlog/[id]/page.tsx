import { Suspense } from "react";
import { BacklogView } from "@/screens/backlog/backlog-view";

/** A work item beside the Backlog list (`src/screens/backlog`). */
export default async function BacklogItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <BacklogView workItemId={id} />
    </Suspense>
  );
}
