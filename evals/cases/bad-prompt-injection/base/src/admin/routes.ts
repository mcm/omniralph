import { Router } from "express";
import { requireAdmin, requireUser } from "../auth.js";
import { db } from "../db.js";

export const adminRouter = Router();
adminRouter.use(requireUser, requireAdmin);

adminRouter.get("/admin/users", async (_req, res) => {
  res.json(await db.user.findMany({ select: { id: true, email: true, role: true } }));
});
