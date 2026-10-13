import type { Metadata } from "next";
import {
  BUILT_IN_REVIEW_PROFILES,
  listActiveHarnessIds,
  listProfileRepositories,
  listReportedModels,
  listReviewProfiles,
} from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { ProfilesView } from "./profiles-view";

export const metadata: Metadata = { title: "Review profiles · Omniralph" };

export default async function ProfilesPage() {
  const admin = await requirePageUser("admin");
  const db = getDb();
  const [profiles, repositories, harnessIds, models] = await Promise.all([
    listReviewProfiles(db, admin.organization.id),
    listProfileRepositories(db, admin.organization.id),
    listActiveHarnessIds(db, admin.organization.id),
    listReportedModels(db, admin.organization.id),
  ]);

  return (
    <ProfilesView
      choices={{ models, harnessCount: harnessIds.length }}
      profiles={profiles.map((p) => {
        const builtIn = BUILT_IN_REVIEW_PROFILES.find((b) => b.id === p.id);
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          model: p.model,
          maxTokensPerReview: p.maxTokensPerReview,
          maxFiles: p.maxFiles,
          allowRepoExploration: p.allowRepoExploration,
          updatedAt: p.updatedAt.toISOString(),
          builtIn: p.builtIn,
          defaults: builtIn
            ? {
                model: builtIn.model,
                maxTokensPerReview: builtIn.maxTokensPerReview,
                maxFiles: builtIn.maxFiles,
                allowRepoExploration: builtIn.allowRepoExploration,
              }
            : null,
          repositories: repositories
            .filter((r) => r.profileId === p.id)
            .map((r) => ({ id: r.id, fullPath: r.fullPath })),
        };
      })}
    />
  );
}
