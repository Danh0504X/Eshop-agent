/**
 * DEMO HELPER: run the FixIt agent for one order from the command line and watch the step-by-step trace.
 *
 *   npm run demo:inspect -- ORD-003
 *
 * Uses the configuration in backend/.env (DEMO_MODE, AI_PROVIDER, AGENT_PLANNER) and acts as the owner of the
 * order's shop. The inspection is stored exactly as if it had been started from the UI.
 */
import { connectDB, disconnectDB } from "../src/config/db";
import { activeModels, env } from "../src/config/env";
import { Inspection } from "../src/models/Inspection";
import { Order } from "../src/models/Order";
import { User } from "../src/models/User";
import { inspectionQueue } from "../src/services/inspectionQueue";
import { startInspection } from "../src/services/inspectionService";

const orderId = process.argv[2];
if (!orderId) {
    console.error("Usage: npm run demo:inspect -- <orderId>   (e.g. ORD-003)");
    process.exit(1);
}

const main = async () => {
    await connectDB();
    const order = await Order.findOne({ orderId });
    if (!order) throw new Error(`Order ${orderId} not found. Run "npm run seed" first?`);
    const owner = await User.findOne({ shopId: order.shopId, role: "owner", active: true });
    if (!owner) throw new Error(`No active owner account for shop ${order.shopId}`);

    const models = activeModels(env);
    console.info(
        `Mode: ${env.aiMode === "demo" ? "DEMO (predefined results, not real AI)" : `REAL ${env.activeProvider} vision=${models?.vision}`} | planner=${env.aiMode === "demo" ? "deterministic" : env.AGENT_PLANNER}${env.AGENT_PLANNER === "llm" && models ? ` (${models.planner})` : ""}\n`,
    );

    const inspection = await startInspection(
        {
            userId: owner.id,
            email: owner.email,
            name: owner.name,
            role: owner.role,
            shopId: owner.shopId,
            warehouseIds: owner.warehouseIds,
        },
        orderId,
    );
    await inspectionQueue.onIdle();

    const done = await Inspection.findById(inspection._id);
    console.info(`\nInspection ${done?.id}: ${done?.status} (${done?.executionLabel})`);
    console.info(`Open it in the UI (order ${orderId}) or GET /api/inspections/${done?.id}`);
};

main()
    .catch((error) => {
        console.error("demo:inspect failed:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => disconnectDB().catch(() => undefined));
