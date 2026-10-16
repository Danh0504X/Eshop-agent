import type { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { asyncHandler } from "../middleware/asyncHandler";
import { principalOf } from "../middleware/authMiddleware";
import { login } from "../services/authService";
import { loginSchema } from "../validators/schemas";

export const signIn: RequestHandler = asyncHandler(async (request, response) => {
    const { email, password } = loginSchema.parse(request.body);
    const { token, user } = await login(email, password);
    response.status(StatusCodes.OK).json({ status: "success", message: "Signed in", data: { token, user } });
});

export const me: RequestHandler = asyncHandler(async (request, response) => {
    response.status(StatusCodes.OK).json({ status: "success", data: { user: principalOf(request) } });
});
