import express from "express";
import { create } from "../controllers/scan.controller";
import { authMiddleware } from "../middleware/authMiddleware";

const router = express.Router();

router.use(authMiddleware);

router.post("/", create);

export default router;
