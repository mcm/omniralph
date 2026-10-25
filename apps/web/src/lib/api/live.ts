import { z } from "zod";

/** `GET /api/ui/live/token`: a subscribe-only Ably JWT, or `token: null` when Ably is off. */
export const liveTokenSchema = z.union([
  z.object({ token: z.string(), expiresAt: z.iso.datetime() }),
  z.object({ token: z.null() }),
]);
export type LiveToken = z.infer<typeof liveTokenSchema>;
