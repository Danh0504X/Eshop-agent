import "dotenv/config";
import fs from "node:fs";
import app from "./app";
import { connectDB } from "./config/db";
import { activeModels, env } from "./config/env";
import { recoverInterruptedInspections } from "./services/inspectionQueue";

const startServer = async () => {
    fs.mkdirSync(env.uploadDirAbs, { recursive: true });
    await connectDB();
    await recoverInterruptedInspections();
    app.listen(env.PORT, () => {
        console.info(`Server is running on port ${env.PORT} [${env.NODE_ENV}]`);
        const models = activeModels(env);
        console.info(
            env.aiMode === "demo" || !models
                ? "Analysis mode: DEMO - predefined results, NOT real AI analysis"
                : `Analysis mode: REAL ${env.activeProvider?.toUpperCase()} (vision=${models.vision}, planner=${env.AGENT_PLANNER}${env.AGENT_PLANNER === "llm" ? `:${models.planner}` : ""})`,
        );
    });
};

startServer().catch((error: unknown) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
});
