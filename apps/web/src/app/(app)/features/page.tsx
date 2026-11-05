import { Suspense } from "react";
import { FeaturesView } from "@/screens/features/features-view";

/** Features: large work planned as a PRFAQ and a Plan (`src/screens/features`). */
export default function FeaturesPage() {
  return (
    <Suspense>
      <FeaturesView />
    </Suspense>
  );
}
