import { NextResponse, type NextRequest } from "next/server";
import { classifyPath, SESSION_COOKIES, SIGN_IN_PATH } from "@/lib/auth/routes";

/**
 * Optimistic auth check: requests without a session cookie are sent to sign-in (pages)
 * or rejected (APIs). The session itself is validated by `requirePageUser`/`requireUser`
 * in layouts, pages and actions. Agent, webhook and cron APIs use their own auth.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const kind = classifyPath(pathname);
  if (kind === "public") return NextResponse.next();
  if (SESSION_COOKIES.some((name) => request.cookies.has(name))) return NextResponse.next();

  if (kind === "api") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const signIn = new URL(SIGN_IN_PATH, request.url);
  signIn.searchParams.set("callbackUrl", `${pathname}${search}`);
  return NextResponse.redirect(signIn);
}

export const config = {
  // Skip Next internals and static files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
