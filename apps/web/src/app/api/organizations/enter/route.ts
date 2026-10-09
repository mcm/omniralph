import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeCallbackPath, SIGN_IN_PATH } from "@/lib/auth/routes";
import { getCurrentUser } from "@/lib/auth/session";
import { activateOrganization } from "@/lib/organizations/active";

/**
 * Switches this device to `?organization=` (one of the user's organizations) and
 * redirects to `?next=`. Detail pages send users here to open a resource of another
 * of their organizations, since pages can't set cookies.
 */
export async function GET(request: NextRequest) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));
  const user = await getCurrentUser();
  if (!user) return to(SIGN_IN_PATH);
  const { searchParams } = request.nextUrl;
  const organizationId = z.uuid().safeParse(searchParams.get("organization"));
  if (!organizationId.success || !(await activateOrganization(user.id, organizationId.data))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return to(safeCallbackPath(searchParams.get("next")));
}
