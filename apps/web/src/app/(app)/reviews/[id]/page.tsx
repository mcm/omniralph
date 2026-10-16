import type { Metadata } from "next";
import { ReviewDetailView } from "./review-detail-view";

export const metadata: Metadata = { title: "Review · Omniralph" };

export default function ReviewPage() {
  return <ReviewDetailView />;
}
