import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getReviewDetail } from "@omniralph/db";
import { z } from "zod";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { reviewDetailView } from "@/lib/reviews/history";
import { ReviewDetailView } from "./review-detail-view";

export const metadata: Metadata = { title: "Review · Omniralph" };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const detail = await getReviewDetail(getDb(), id);
  if (!detail) notFound();
  return <ReviewDetailView review={reviewDetailView(detail)} />;
}
