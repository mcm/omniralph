"use server";

import { signIn, signOut } from "@/auth";
import { safeCallbackPath, SIGN_IN_PATH } from "./routes";

export async function signInWithProvider(provider: "github" | "gitlab", callbackUrl: string) {
  await signIn(provider, { redirectTo: safeCallbackPath(callbackUrl) });
}

export async function signOutAction() {
  await signOut({ redirectTo: SIGN_IN_PATH });
}
