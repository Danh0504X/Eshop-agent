import express from "express";
import mongoose from "mongoose";
import swaggerUi from "swagger-ui-express";
import { activeModels, env } from "../config/env";
import { openApiDocument } from "../docs/openapi";
import authRoute from "./authRoute";
import claimRoute from "./claimRoute";
import inspectionRoute from "./inspectionRoute";
import mediaRoute from "./mediaRoute";
import orderRoute from "./orderRoute";

const router = express.Router();

router.get("/health", (_request, response) => {
    const dbUp = mongoose.connection.readyState === 1;
    const models = activeModels(env);
    response.status(dbUp ? 200 : 503).json({
        status: dbUp ? "ok" : "degraded",
        database: dbUp ? "connected" : "disconnected",
        // Surfaced so the UI and operators always know whether results are real AI analysis or demo data.
        analysisMode: env.aiMode,
        aiProvider: env.activeProvider,
        aiModel: models?.vision ?? null,
        plannerModel: models && env.AGENT_PLANNER === "llm" ? models.planner : null,
        planner: env.aiMode === "real" ? env.AGENT_PLANNER : "deterministic",
    });
});

router.get("/openapi.json", (_request, response) => {
    response.json(openApiDocument);
});
router.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument, { customSiteTitle: "FixIt AI Agent API" }));

router.use("/auth", authRoute);
router.use("/orders", orderRoute);
router.use("/media", mediaRoute);
router.use("/inspections", inspectionRoute);
router.use("/claims", claimRoute);

export default router;
