import { Suspense } from "react";
import { ReposView } from "@/screens/repos/repos-view";

/** A repo's settings beside the Repos rail (`src/screens/repos`); `?tab=` opens on a section. */
export default async function RepoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ReposView repositoryId={id} />
    </Suspense>
  );
}
