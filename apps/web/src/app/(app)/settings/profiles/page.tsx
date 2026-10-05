import type { Metadata } from "next";
import { listReviewProfiles } from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { ProfilesView } from "./profiles-view";

export const metadata: Metadata = { title: "Review profiles · Omniralph" };

export default async function ProfilesPage() {
  await requirePageUser("admin");
  const profiles = await listReviewProfiles(getDb());

  return (
    <ProfilesView
      profiles={profiles.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        model: p.model,
        maxTokensPerReview: p.maxTokensPerReview,
        maxFiles: p.maxFiles,
        allowRepoExploration: p.allowRepoExploration,
        updatedAt: p.updatedAt.toISOString(),
      }))}
    />
  );
}
