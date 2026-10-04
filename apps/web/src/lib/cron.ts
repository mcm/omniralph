import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Whether the request carries `Authorization: Bearer $CRON_SECRET` (sent by Vercel Cron). */
export function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || !header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export function cronUnauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
