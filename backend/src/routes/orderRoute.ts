import express from "express";
import { listForOrder, upload } from "../controllers/media.controller";
import { create, getOne, list } from "../controllers/order.controller";
import { authMiddleware } from "../middleware/authMiddleware";
import { videoUpload } from "../middleware/uploadMiddleware";

const router = express.Router();

router.use(authMiddleware);

router.post("/", create);
router.get("/", list);
router.get("/:orderId", getOne);
router.post("/:orderId/media", videoUpload, upload);
router.get("/:orderId/media", listForOrder);

export default router;
