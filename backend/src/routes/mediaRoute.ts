import express from "express";
import { remove, streamFile, streamFrame } from "../controllers/media.controller";
import { authMiddleware } from "../middleware/authMiddleware";

const router = express.Router();

router.use(authMiddleware);

router.get("/:mediaId/file", streamFile);
router.get("/:mediaId/frames/:frameId", streamFrame);
router.delete("/:mediaId", remove);

export default router;
