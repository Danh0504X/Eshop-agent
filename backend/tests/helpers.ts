import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import mongoose from "mongoose";
import { inject } from "vitest";
import { Order } from "../src/models/Order";
import { User } from "../src/models/User";
import { hashPassword, signToken } from "../src/services/authService";
import type { AuthPrincipal } from "../src/types/auth";

const run = promisify(execFile);

/** Connect this test file to its own fresh database on the shared in-memory server. */
export const connectTestDb = async (): Promise<void> => {
    const base = inject("mongoUri");
    const dbName = `fixit_test_${crypto.randomBytes(4).toString("hex")}`;
    await mongoose.connect(base, { dbName });
};

export const disconnectTestDb = async (): Promise<void> => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
};

export interface TestUser {
    principal: AuthPrincipal;
    token: string;
}

export const createUser = async (
    attrs: Partial<AuthPrincipal> & Pick<AuthPrincipal, "role" | "shopId">,
    password = "test-password",
): Promise<TestUser> => {
    const email = attrs.email ?? `${attrs.role}-${crypto.randomBytes(3).toString("hex")}@example.test`;
    const user = await User.create({
        email,
        name: attrs.name ?? `${attrs.role} user`,
        passwordHash: await hashPassword(password),
        role: attrs.role,
        shopId: attrs.shopId,
        warehouseIds: attrs.warehouseIds ?? [],
    });
    const principal: AuthPrincipal = {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        shopId: user.shopId,
        warehouseIds: user.warehouseIds,
    };
    return { principal, token: signToken(principal) };
};

export const createOrder = (overrides: Record<string, unknown> = {}) =>
    Order.create({
        orderId: `ORD-${crypto.randomBytes(3).toString("hex")}`,
        trackingCode: `TRK-${crypto.randomBytes(3).toString("hex")}`,
        shopId: "shop-a",
        warehouseId: "wh-1",
        product: { name: "Wireless Headphones", model: "WH-100", color: "black" },
        expectedQuantity: 1,
        expectedAccessories: ["charging cable"],
        declaredValue: 120,
        ...overrides,
    });

const FIXTURE_DIR = path.resolve("tests/.fixtures");

export type VideoKind = "normal" | "dark" | "blurry" | "short";

/** Generate (and cache) a small synthetic test video with FFmpeg. */
export const makeVideo = async (kind: VideoKind = "normal"): Promise<string> => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const out = path.join(FIXTURE_DIR, `${kind}.mp4`);
    if (fs.existsSync(out)) return out;
    const filters: Record<VideoKind, string | null> = {
        normal: null,
        short: null,
        dark: "lutyuv=y=val*0.08",
        blurry: "boxblur=12:6",
    };
    const duration = kind === "short" ? "1" : "4";
    const args = ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", duration];
    if (filters[kind]) args.push("-vf", filters[kind]!);
    args.push("-pix_fmt", "yuv420p", "-c:v", "libx264", out);
    await run(ffmpegStatic as unknown as string, args);
    return out;
};

/** Copy a fixture video into storage and register it as linked evidence on the order. */
export const createMediaFromFile = async (
    order: { _id: mongoose.Types.ObjectId; orderId: string; shopId: string; warehouseId: string },
    type: "outbound" | "return",
    filePath: string,
    uploadedBy: string,
) => {
    const { MediaEvidence } = await import("../src/models/MediaEvidence");
    const { Order: OrderModel } = await import("../src/models/Order");
    const { storage } = await import("../src/services/storageService");
    const key = `media/${order.shopId}/${order.orderId}/${type}-${crypto.randomUUID()}.mp4`;
    await storage().writeBuffer(key, fs.readFileSync(filePath));
    const media = await MediaEvidence.create({
        orderId: order.orderId,
        orderRef: order._id,
        shopId: order.shopId,
        warehouseId: order.warehouseId,
        type,
        storageKey: key,
        mimeType: "video/mp4",
        sizeBytes: fs.statSync(filePath).size,
        sha256: "test",
        uploadedBy,
        status: "linked",
    });
    await OrderModel.updateOne(
        { _id: order._id },
        { $set: { [type === "outbound" ? "packingMedia" : "returnMedia"]: [media._id] } },
    );
    return media;
};
