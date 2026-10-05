import { Router } from "express";
import { requireUser } from "../auth.js";
import { db } from "../db.js";

export const documentsRouter = Router();
documentsRouter.use(requireUser);

/** Documents are private to their owner; other users get a 404. */
documentsRouter.get("/documents/:id", async (req, res) => {
  const doc = await db.document.findUnique({ where: { id: req.params.id } });
  if (!doc || doc.ownerId !== req.user.id) return res.status(404).end();
  res.json(doc);
});

documentsRouter.patch("/documents/:id", async (req, res) => {
  const doc = await db.document.findUnique({ where: { id: req.params.id } });
  if (!doc || doc.ownerId !== req.user.id) return res.status(404).end();
  const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 200) : doc.title;
  res.json(await db.document.update({ where: { id: doc.id }, data: { title } }));
});
