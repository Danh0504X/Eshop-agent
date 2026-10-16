import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env";
import authRoute from "./authRoute";
import mediaRoute from "./mediaRoute";
import orderRoute from "./orderRoute";

const router = express.Router();

router.get("/health", (_request, response) => {
    const dbUp = mongoose.connection.readyState === 1;
    response.status(dbUp ? 200 : 503).json({
        status: dbUp ? "ok" : "degraded",
        database: dbUp ? "connected" : "disconnected",
        // Surfaced so the UI and operators always know whether results are real AI analysis or demo data.
        analysisMode: env.aiMode,
        aiModel: env.aiMode === "real" ? env.AI_MODEL : null,
        planner: env.aiMode === "real" ? env.AGENT_PLANNER : "deterministic",
    });
});

router.use("/auth", authRoute);
router.use("/orders", orderRoute);
router.use("/media", mediaRoute);

export default router;
