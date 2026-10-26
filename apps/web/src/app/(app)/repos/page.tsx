import { Suspense } from "react";
import { ReposView } from "@/screens/repos/repos-view";

/** Repos: every repo of the user's scope, beside the first one's settings when both fit (`src/screens/repos`). */
export default function ReposPage() {
  return (
    <Suspense>
      <ReposView />
    </Suspense>
  );
}
