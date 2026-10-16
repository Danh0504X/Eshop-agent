import express from "express";
import { listForOrder as listInspections, start as startInspection } from "../controllers/inspection.controller";
import { listForOrder, upload } from "../controllers/media.controller";
import { create, getOne, list } from "../controllers/order.controller";
import { authMiddleware } from "../middleware/authMiddleware";
import { inspectionRateLimit } from "../middleware/rateLimitMiddleware";
import { videoUpload } from "../middleware/uploadMiddleware";

const router = express.Router();

router.use(authMiddleware);

router.post("/", create);
router.get("/", list);
router.get("/:orderId", getOne);
router.post("/:orderId/media", videoUpload, upload);
router.get("/:orderId/media", listForOrder);
router.post("/:orderId/inspect", inspectionRateLimit, startInspection);
router.get("/:orderId/inspections", listInspections);

export default router;
