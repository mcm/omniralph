import type { Metadata } from "next";
import { ReviewsView } from "../../../reviews/reviews-view";

export const metadata: Metadata = { title: "Repository reviews · Omniralph" };

export default function RepositoryReviewsPage() {
  return <ReviewsView inRepository />;
}
