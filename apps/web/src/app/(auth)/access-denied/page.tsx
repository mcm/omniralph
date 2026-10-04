import type { Metadata } from "next";
import { AccessDeniedView } from "./access-denied-view";

export const metadata: Metadata = { title: "Access denied · Omniralph" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AccessDeniedPage({ searchParams }: { searchParams: SearchParams }) {
  const { reason } = await searchParams;
  return <AccessDeniedView reason={reason === "forbidden" ? "forbidden" : "not-allowed"} />;
}
