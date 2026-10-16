import type { Metadata } from "next";
import { ReviewsView } from "./reviews-view";

export const metadata: Metadata = { title: "Reviews · Omniralph" };

export default function ReviewsPage() {
  return <ReviewsView />;
}
