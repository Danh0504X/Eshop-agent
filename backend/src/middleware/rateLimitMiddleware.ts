import rateLimit from "express-rate-limit";
import { env } from "../config/env";
import { ApiError } from "../utils/errors";

/**
 * Limits expensive AI operations (start/retry inspection) per authenticated user.
 * Must run after authMiddleware. The limit is read per request so it follows config overrides.
 */
export const inspectionRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: () => env.RATE_LIMIT_INSPECTIONS_PER_15MIN,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (request) => `user:${request.user?.userId ?? "anonymous"}`,
    handler: (_request, _response, next) =>
        next(new ApiError("RATE_LIMITED", "Too many inspection requests. Try again later.")),
});
