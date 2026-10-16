import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";
import { User } from "../models/User";
import type { AuthPrincipal } from "../types/auth";
import { ApiError } from "../utils/errors";
import { recordAudit } from "./auditService";

const TokenPayload = z.object({
    sub: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.enum(["owner", "employee"]),
    shopId: z.string(),
    warehouseIds: z.array(z.string()),
});

// Real hash of a random value; compared against when the user does not exist so timing does not reveal valid emails.
const DUMMY_HASH = bcrypt.hashSync(Math.random().toString(36), 10);

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, 10);

export const signToken = (principal: AuthPrincipal): string =>
    jwt.sign(
        {
            email: principal.email,
            name: principal.name,
            role: principal.role,
            shopId: principal.shopId,
            warehouseIds: principal.warehouseIds,
        },
        env.JWT_SECRET,
        { subject: principal.userId, expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] },
    );

export const verifyToken = (token: string): AuthPrincipal => {
    let decoded: unknown;
    try {
        decoded = jwt.verify(token, env.JWT_SECRET);
    } catch {
        throw new ApiError("UNAUTHENTICATED", "Invalid or expired token");
    }
    const parsed = TokenPayload.safeParse(decoded);
    if (!parsed.success) throw new ApiError("UNAUTHENTICATED", "Malformed token");
    const { sub, ...rest } = parsed.data;
    return { userId: sub, ...rest };
};

export const login = async (email: string, password: string): Promise<{ token: string; user: AuthPrincipal }> => {
    const user = await User.findOne({ email: email.toLowerCase(), active: true }).select("+passwordHash");
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
        await recordAudit({ action: "auth.login", actorType: "user", outcome: "denied", details: { email } });
        throw new ApiError("UNAUTHENTICATED", "Invalid email or password");
    }
    const principal: AuthPrincipal = {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        shopId: user.shopId,
        warehouseIds: user.warehouseIds,
    };
    await recordAudit({ action: "auth.login", actorType: "user", actorId: user.id, shopId: user.shopId });
    return { token: signToken(principal), user: principal };
};
