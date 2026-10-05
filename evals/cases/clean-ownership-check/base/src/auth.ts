import type { NextFunction, Request, Response } from "express";
import { verifySession } from "./session.js";

/** Rejects requests without a valid session; sets `req.user` ({ id, email }). */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = await verifySession(req.cookies?.session);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  req.user = user;
  next();
}
