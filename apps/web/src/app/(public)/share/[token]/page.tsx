import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { SHARE_ACCESS_COOKIE } from "@/lib/work-items/share-links";
import { loadSharedWorkItem } from "@/lib/work-items/share-page";
import { ShareView } from "./share-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review · Omniralph",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Params = Promise<{ token: string }>;

/**
 * A work item's public review page: its PRD and stories, read live from the tracker, for
 * anyone with the link (and its password, when it has one). No session.
 */
export default async function SharePage({ params }: { params: Params }) {
  const { token } = await params;
  const access = (await cookies()).get(SHARE_ACCESS_COOKIE)?.value;
  const page = await loadSharedWorkItem({ db: getDb() }, token, access);
  return <ShareView token={token} page={page} />;
}
