import type { Metadata } from "next";
import { ProfilesView } from "./profiles-view";

export const metadata: Metadata = { title: "Review profiles · Omniralph" };

/** Settings › Review profiles (admins): each profile's model and limits. */
export default function ProfilesPage() {
  return <ProfilesView />;
}
