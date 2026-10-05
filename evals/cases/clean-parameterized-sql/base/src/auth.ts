import type { NextFunction, Request, Response } from "express";
import { verifySession } from "./session.js";

/** Rejects requests without a valid session cookie; sets `req.user`. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = await verifySession(req.cookies?.session);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  req.user = user;
  next();
}
