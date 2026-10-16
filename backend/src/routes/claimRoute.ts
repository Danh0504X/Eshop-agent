import express from "express";
import {
    approve,
    downloadReport,
    getOne,
    list,
    markSubmitted,
    refund,
    reject,
    resolve,
} from "../controllers/claim.controller";
import { authMiddleware } from "../middleware/authMiddleware";

const router = express.Router();

router.use(authMiddleware);

router.get("/", list);
router.get("/:claimId", getOne);
router.get("/:claimId/report", downloadReport);
router.post("/:claimId/approve", approve);
router.post("/:claimId/reject", reject);
router.post("/:claimId/mark-submitted", markSubmitted);
router.post("/:claimId/resolve", resolve);
router.post("/:claimId/refund", refund);

export default router;
