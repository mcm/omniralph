import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { configuredProviders } from "@/auth";
import { devSignInEnabled } from "@/lib/auth/dev-sign-in";
import { safeCallbackPath } from "@/lib/auth/routes";
import { getCurrentUser } from "@/lib/auth/session";
import { SignInView } from "./sign-in-view";

export const metadata: Metadata = { title: "Sign in · Omniralph" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const callbackUrl = safeCallbackPath(params.callbackUrl);
  if (await getCurrentUser()) redirect(callbackUrl);

  const error = typeof params.error === "string" ? params.error : null;
  if (error === "AccessDenied") redirect("/access-denied");

  return (
    <SignInView
      providers={configuredProviders()}
      callbackUrl={callbackUrl}
      error={error}
      devSignIn={devSignInEnabled()}
    />
  );
}
