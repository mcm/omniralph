import { Suspense } from "react";
import { FeaturesView } from "@/screens/features/features-view";

/** A feature beside the Features list (`src/screens/features`). */
export default async function FeaturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <FeaturesView featureId={id} />
    </Suspense>
  );
}
