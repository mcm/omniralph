import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRepositoryWithConnection, listReviews, REVIEW_PAGE_SIZE } from "@omniralph/db";
import { z } from "zod";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { parseReviewListParams } from "@/lib/reviews/display";
import { reviewRow } from "@/lib/reviews/history";
import { ReviewsView } from "../../../reviews/reviews-view";

export const metadata: Metadata = { title: "Repository reviews · Omniralph" };

export default async function RepositoryReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  const found = await getRepositoryWithConnection(db, id, user.organization.id);
  // Disconnected repositories keep their history, so it stays browsable.
  if (!found) notFound();
  const { repository, connection } = found;
  const listParams = parseReviewListParams(await searchParams);
  const page = await listReviews(db, {
    organizationId: user.organization.id,
    repositoryId: id,
    status: listParams.status ?? undefined,
    trigger: listParams.trigger ?? undefined,
    page: listParams.page,
    pageSize: REVIEW_PAGE_SIZE,
  });

  return (
    <ReviewsView
      repository={{
        id: repository.id,
        provider: repository.provider,
        fullPath: repository.fullPath,
        webUrl: repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath),
        connected: repository.disconnectedAt === null,
      }}
      reviews={page.reviews.map(reviewRow)}
      params={listParams}
      total={page.total}
      pageSize={page.pageSize}
    />
  );
}
