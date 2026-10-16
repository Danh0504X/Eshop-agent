import express from "express";
import { me, signIn } from "../controllers/auth.controller";
import { authMiddleware } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/login", signIn);
router.get("/me", authMiddleware, me);

export default router;
