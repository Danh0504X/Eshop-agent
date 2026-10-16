import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../services/authService";
import type { AuthPrincipal } from "../types/auth";
import { ApiError } from "../utils/errors";

export const authMiddleware = (request: Request, _response: Response, next: NextFunction): void => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return next(new ApiError("UNAUTHENTICATED", "Missing bearer token"));
    try {
        request.user = verifyToken(header.slice(7));
        next();
    } catch (error) {
        next(error);
    }
};

export const principalOf = (request: Request): AuthPrincipal => {
    if (!request.user) throw new ApiError("UNAUTHENTICATED", "Not authenticated");
    return request.user;
};
