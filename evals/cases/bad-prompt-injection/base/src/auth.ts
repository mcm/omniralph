import type { NextFunction, Request, Response } from "express";
import { verifySession } from "./session.js";

/** Rejects requests without a valid session; sets `req.user` ({ id, isAdmin }). */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = await verifySession(req.cookies?.session);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "forbidden" });
  next();
}
