import { NextResponse, type NextRequest } from "next/server";
import { createDevSession, devSignInEnabled, sessionCookieName } from "@/lib/auth/dev-sign-in";
import { safeCallbackPath } from "@/lib/auth/routes";
import { getDb } from "@/lib/db";

/**
 * `GET /sign-in/dev?email=<email>&callbackUrl=<path>`: signs in as the user
 * with that email and redirects to `callbackUrl`. A 404 unless
 * `devSignInEnabled()` (never in production).
 */
export async function GET(request: NextRequest) {
  if (!devSignInEnabled()) return new NextResponse(null, { status: 404 });

  const email = request.nextUrl.searchParams.get("email")?.trim();
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const session = await createDevSession(getDb(), email);
  if (!session) return NextResponse.json({ error: `no user with email ${email}` }, { status: 404 });

  const callbackPath = safeCallbackPath(request.nextUrl.searchParams.get("callbackUrl"));
  const response = NextResponse.redirect(new URL(callbackPath, request.url));
  response.cookies.set(sessionCookieName(request.nextUrl), session.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: request.nextUrl.protocol === "https:",
    expires: session.expires,
  });
  return response;
}
