import "dotenv/config";
import fs from "node:fs";
import app from "./app";
import { connectDB } from "./config/db";
import { env } from "./config/env";

const startServer = async () => {
    fs.mkdirSync(env.uploadDirAbs, { recursive: true });
    await connectDB();
    app.listen(env.PORT, () => {
        console.info(`Server is running on port ${env.PORT} [${env.NODE_ENV}]`);
        console.info(
            env.aiMode === "demo"
                ? "Analysis mode: DEMO - predefined results, NOT real AI analysis"
                : `Analysis mode: REAL AI (${env.AI_MODEL}, planner=${env.AGENT_PLANNER})`,
        );
    });
};

startServer().catch((error: unknown) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
});
