/**
 * DEVELOPMENT ONLY: seeds demo users, orders and synthetic evidence videos.
 *
 *   npm run seed            create anything missing
 *   npm run seed -- --reset delete all demo-shop / other-shop data first
 *
 * The synthetic videos are FFmpeg test patterns, not real products. They exercise the real pipeline
 * (upload storage, frame extraction, quality checks). Meaningful product findings come from DEMO_MODE's
 * predefined scenarios; in real AI mode, record real packing/return videos instead (see README).
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { connectDB, disconnectDB } from "../src/config/db";
import { env } from "../src/config/env";
import { AuditLog } from "../src/models/AuditLog";
import { Claim } from "../src/models/Claim";
import { Inspection } from "../src/models/Inspection";
import { MediaEvidence } from "../src/models/MediaEvidence";
import { Order } from "../src/models/Order";
import { ScanSession } from "../src/models/ScanSession";
import { User } from "../src/models/User";
import { hashPassword } from "../src/services/authService";
import { resolveBinaries } from "../src/services/ffmpegService";
import { storage } from "../src/services/storageService";

const run = promisify(execFile);

if (env.NODE_ENV === "production") {
    console.error("Refusing to seed: NODE_ENV=production. The seed script is for local development only.");
    process.exit(1);
}

const SHOP = "demo-shop";
const OTHER_SHOP = "other-shop";
const PASSWORD = process.env.SEED_USER_PASSWORD || "dev-password-change-me";
const VIDEO_DIR = path.resolve("sample-videos");

type Kind = "packing" | "return" | "dark";

const VIDEO_FILTERS: Record<Kind, string> = {
    packing: "testsrc2=size=640x360:rate=15",
    return: "smptehdbars=size=640x360:rate=15",
    dark: "testsrc2=size=640x360:rate=15,lutyuv=y=val*0.1",
};

/** Generate a short synthetic test video with FFmpeg (cached in sample-videos/). */
const sampleVideo = async (kind: Kind): Promise<string> => {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
    const out = path.join(VIDEO_DIR, `${kind}.mp4`);
    if (fs.existsSync(out)) return out;
    const { ffmpeg } = await resolveBinaries();
    await run(ffmpeg, [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        VIDEO_FILTERS[kind],
        "-t",
        "6",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        out,
    ]);
    return out;
};

interface DemoOrder {
    orderId: string;
    trackingCode: string;
    warehouseId: string;
    demoScenario: string;
    product: { name: string; description?: string; sku?: string; model?: string; color?: string };
    expectedQuantity: number;
    expectedAccessories: string[];
    customer?: { name: string; phone: string; address: string };
    outbound: Kind | null;
    returned: Kind | null;
    note: string;
}

const ORDERS: DemoOrder[] = [
    {
        orderId: "ORD-001",
        trackingCode: "TRK-1001",
        warehouseId: "wh-hcm",
        demoScenario: "normal",
        product: { name: "Wireless Headphones", model: "WH-100", color: "black", sku: "WH100-BLK" },
        expectedQuantity: 1,
        expectedAccessories: ["charging cable", "carry pouch"],
        customer: { name: "Nguyen Van A", phone: "0912 345 678", address: "12 Nguyen Trai Street, District 1" },
        outbound: "packing",
        returned: "return",
        note: "Normal return - expected to complete with no claim",
    },
    {
        orderId: "ORD-002",
        trackingCode: "TRK-1002",
        warehouseId: "wh-hcm",
        demoScenario: "missing_item",
        product: { name: "Silicone Phone Case", model: "PC-15", color: "blue", sku: "PC15-BLU" },
        expectedQuantity: 2,
        expectedAccessories: [],
        outbound: "packing",
        returned: "return",
        note: "One of two items missing - expected draft claim",
    },
    {
        orderId: "ORD-003",
        trackingCode: "TRK-1003",
        warehouseId: "wh-hcm",
        demoScenario: "mismatch",
        product: { name: "Smart Watch", model: "SW-200", color: "silver", sku: "SW200-SLV" },
        expectedQuantity: 1,
        expectedAccessories: ["magnetic charger"],
        outbound: "packing",
        returned: "return",
        note: "Different model/colour returned - expected draft claim",
    },
    {
        orderId: "ORD-004",
        trackingCode: "TRK-1004",
        warehouseId: "wh-hcm",
        demoScenario: "normal",
        product: { name: "Bluetooth Speaker", model: "BS-50", color: "red" },
        expectedQuantity: 1,
        expectedAccessories: ["USB-C cable"],
        outbound: "packing",
        returned: null,
        note: "Return video missing - expected human review; upload one and retry",
    },
    {
        orderId: "ORD-005",
        trackingCode: "TRK-1005",
        warehouseId: "wh-hcm",
        demoScenario: "normal",
        product: { name: "Mechanical Keyboard", model: "MK-87", color: "white" },
        expectedQuantity: 1,
        expectedAccessories: ["keycap puller"],
        outbound: "packing",
        returned: "dark",
        note: "Return video too dark - expected human review before any AI call",
    },
    {
        orderId: "ORD-006",
        trackingCode: "TRK-1006",
        warehouseId: "wh-hcm",
        demoScenario: "mismatch",
        product: { name: "Mirrorless Camera Body", model: "MC-9", color: "black" },
        expectedQuantity: 1,
        expectedAccessories: ["battery", "body cap"],
        outbound: "packing",
        returned: "return",
        note: "Different camera body returned - expected draft claim",
    },
    {
        orderId: "ORD-007",
        trackingCode: "TRK-1007",
        warehouseId: "wh-hcm",
        demoScenario: "empty_package",
        product: { name: "Wireless Earbuds", model: "EB-3", color: "white" },
        expectedQuantity: 1,
        expectedAccessories: ["charging case"],
        outbound: null,
        returned: null,
        note: "No evidence yet - use it to try uploads from the UI",
    },
    {
        orderId: "ORD-008",
        trackingCode: "TRK-1008",
        warehouseId: "wh-hcm",
        demoScenario: "needs_closer_look",
        product: { name: "Fitness Tracker", model: "FT-3", color: "black" },
        expectedQuantity: 1,
        expectedAccessories: ["charging clip"],
        outbound: "packing",
        returned: "return",
        note: "Casing unclear at first - with AGENT_PLANNER=gemini the agent can inspect a segment, re-analyse and claim",
    },
    {
        orderId: "ORD-101",
        trackingCode: "TRK-2101",
        warehouseId: "wh-hn",
        demoScenario: "normal",
        product: { name: "Desk Lamp", model: "DL-1", color: "white" },
        expectedQuantity: 1,
        expectedAccessories: [],
        outbound: "packing",
        returned: "return",
        note: "Different warehouse - invisible to the demo employee (warehouse isolation)",
    },
];

const reset = async () => {
    const shops = [SHOP, OTHER_SHOP];
    const media = await MediaEvidence.find({ shopId: { $in: shops } });
    for (const m of media) {
        await storage().delete(m.storageKey);
        for (const f of m.frames) await storage().delete(f.storageKey);
    }
    const claims = await Claim.find({ shopId: { $in: shops } });
    for (const c of claims) if (c.reportStorageKey) await storage().delete(c.reportStorageKey);
    await Promise.all([
        MediaEvidence.deleteMany({ shopId: { $in: shops } }),
        Claim.deleteMany({ shopId: { $in: shops } }),
        Inspection.deleteMany({ shopId: { $in: shops } }),
        Order.deleteMany({ shopId: { $in: shops } }),
        AuditLog.deleteMany({ shopId: { $in: shops } }),
        ScanSession.deleteMany({ shopId: { $in: shops } }),
        User.deleteMany({ shopId: { $in: shops } }),
    ]);
    console.info("Removed existing demo data.");
};

const upsertUser = async (
    email: string,
    name: string,
    role: "owner" | "employee",
    shopId: string,
    warehouseIds: string[] = [],
) => {
    const existing = await User.findOne({ email });
    if (existing) return existing;
    return User.create({ email, name, role, shopId, warehouseIds, passwordHash: await hashPassword(PASSWORD) });
};

const attachVideo = async (
    order: InstanceType<typeof Order>,
    type: "outbound" | "return",
    kind: Kind,
    uploadedBy: string,
) => {
    const file = await sampleVideo(kind);
    const data = fs.readFileSync(file);
    const key = `media/${order.shopId}/${order.orderId}/${type}-${crypto.randomUUID()}.mp4`;
    await storage().writeBuffer(key, data);
    // Every video is bound to a scan of the order's label; demo videos are attached as files.
    const scan = await ScanSession.create({
        shopId: order.shopId,
        scannedBy: uploadedBy,
        code: order.trackingCode,
        purpose: type === "outbound" ? "packing" : "return",
        method: "hand_scanner",
        orderRef: order._id,
        orderId: order.orderId,
        expiresAt: new Date(),
        mediaLinkedAt: new Date(),
    });
    const media = await MediaEvidence.create({
        orderId: order.orderId,
        orderRef: order._id,
        shopId: order.shopId,
        warehouseId: order.warehouseId,
        type,
        storageKey: key,
        originalName: `${type}-${kind}.mp4`,
        mimeType: "video/mp4",
        sizeBytes: data.length,
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
        uploadedBy,
        status: "linked",
        capture: {
            scanId: scan._id,
            scanMethod: scan.method,
            scannedAt: scan.createdAt,
            scannedBy: uploadedBy,
            captureMethod: "file",
        },
    });
    await ScanSession.updateOne({ _id: scan._id }, { $set: { mediaRef: media._id } });
    order.set(type === "outbound" ? "packingMedia" : "returnMedia", [media._id]);
};

const main = async () => {
    await connectDB();
    if (process.argv.includes("--reset")) await reset();

    const owner = await upsertUser("owner@demo-shop.test", "Demo Shop Owner", "owner", SHOP);
    const staff = await upsertUser("staff@demo-shop.test", "Demo Warehouse Staff", "employee", SHOP, ["wh-hcm"]);
    await upsertUser("owner@other-shop.test", "Other Shop Owner", "owner", OTHER_SHOP);

    let created = 0;
    for (const spec of ORDERS) {
        if (await Order.exists({ shopId: SHOP, orderId: spec.orderId })) continue;
        const { outbound, returned, note: _note, ...fields } = spec;
        const order = new Order({ ...fields, shopId: SHOP, createdBy: owner._id });
        if (outbound) await attachVideo(order, "outbound", outbound, staff.id);
        if (returned) await attachVideo(order, "return", returned, staff.id);
        await order.save();
        created++;
    }

    console.info(`\nSeed complete: ${created} new order(s). Analysis mode: ${env.aiMode.toUpperCase()}.`);
    if (env.aiMode === "real") {
        console.info(
            "NOTE: seeded videos are synthetic test patterns. Real AI analysis of them will (correctly) escalate.",
        );
    }
    console.info(
        `\nDevelopment logins (password: ${PASSWORD === "dev-password-change-me" ? "dev-password-change-me" : "<SEED_USER_PASSWORD>"})`,
    );
    console.info("  owner@demo-shop.test   owner of demo-shop (all warehouses; can approve claims)");
    console.info("  staff@demo-shop.test   employee, warehouse wh-hcm only");
    console.info("  owner@other-shop.test  owner of another shop (sees none of the demo orders)\n");
    console.info("Orders:");
    for (const o of ORDERS) console.info(`  ${o.orderId}  ${o.product.name.padEnd(24)} ${o.note}`);
    await disconnectDB();
};

main().catch(async (error) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
});
