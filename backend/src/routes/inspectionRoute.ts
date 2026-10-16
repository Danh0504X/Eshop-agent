import express from "express";
import { getOne, retry } from "../controllers/inspection.controller";
import { authMiddleware } from "../middleware/authMiddleware";
import { inspectionRateLimit } from "../middleware/rateLimitMiddleware";

const router = express.Router();

router.use(authMiddleware);

router.get("/:inspectionId", getOne);
router.post("/:inspectionId/retry", inspectionRateLimit, retry);

export default router;
