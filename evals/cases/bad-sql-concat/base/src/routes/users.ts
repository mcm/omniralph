import { Router } from "express";
import { requireUser } from "../auth.js";
import { findUserById } from "../users/repository.js";

export const usersRouter = Router();
usersRouter.use(requireUser);

usersRouter.get("/users/:id", async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json(user);
});
