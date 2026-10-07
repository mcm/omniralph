import type { Metadata } from "next";
import { listReviews, REVIEW_PAGE_SIZE } from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { parseReviewListParams } from "@/lib/reviews/display";
import { reviewRow } from "@/lib/reviews/history";
import { ReviewsView } from "./reviews-view";

export const metadata: Metadata = { title: "Reviews · Omniralph" };

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const params = parseReviewListParams(await searchParams);
  const page = await listReviews(getDb(), {
    organizationId: user.organization.id,
    status: params.status ?? undefined,
    trigger: params.trigger ?? undefined,
    page: params.page,
    pageSize: REVIEW_PAGE_SIZE,
  });
  return (
    <ReviewsView
      repository={null}
      reviews={page.reviews.map(reviewRow)}
      params={params}
      total={page.total}
      pageSize={page.pageSize}
    />
  );
}
