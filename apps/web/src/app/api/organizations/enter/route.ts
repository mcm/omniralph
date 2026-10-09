import { NextResponse, type NextRequest } from "next/server";
import { safeCallbackPath, SIGN_IN_PATH } from "@/lib/auth/routes";
import { getCurrentUser } from "@/lib/auth/session";
import { activateOrganization } from "@/lib/organizations/active";
import { readEnterOrganizationToken } from "@/lib/organizations/enter";

/**
 * Switches this device to the organization in `?token=` (one of the user's organizations)
 * and redirects to the token's next path. Detail pages send users here to open a resource
 * of another of their organizations, since pages can't set cookies. The token is signed
 * (`lib/organizations/enter.ts`), so a link from another site can't switch organizations.
 */
export async function GET(request: NextRequest) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));
  const user = await getCurrentUser();
  if (!user) return to(SIGN_IN_PATH);
  const enter = await readEnterOrganizationToken(
    request.nextUrl.searchParams.get("token"),
    user.id,
  );
  if (!enter || !(await activateOrganization(user.id, enter.organizationId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return to(safeCallbackPath(enter.next));
}
