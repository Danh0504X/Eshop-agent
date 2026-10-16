import type { ErrorRequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import multer from "multer";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { env } from "../config/env";
import { ApiError } from "../utils/errors";
import { logger } from "../utils/logger";

type ErrorWithStatus = Error & {
    statusCode?: number;
    errors?: unknown[];
    code?: unknown;
};

/** Map library errors (Zod, Multer, Mongoose, body-parser) onto the ApiError shape. */
const normalize = (error: unknown): ErrorWithStatus => {
    if (error instanceof ApiError) return error;
    if (error instanceof ZodError) {
        return new ApiError(
            "VALIDATION_ERROR",
            "Request validation failed",
            error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        );
    }
    if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
            return new ApiError("PAYLOAD_TOO_LARGE", `File exceeds the ${env.MAX_UPLOAD_SIZE_MB} MB upload limit`);
        }
        return new ApiError("VALIDATION_ERROR", `Upload rejected: ${error.message}`);
    }
    if (error instanceof mongoose.Error.CastError) {
        return new ApiError("VALIDATION_ERROR", `Invalid value for ${error.path}`);
    }
    if (error instanceof mongoose.Error.ValidationError) {
        return new ApiError(
            "VALIDATION_ERROR",
            "Document validation failed",
            Object.values(error.errors).map((e) => ({ path: e.path, message: e.message })),
        );
    }
    if ((error as { code?: unknown }).code === 11000) {
        return new ApiError("CONFLICT", "A record with the same unique key already exists");
    }
    // body-parser JSON syntax errors carry a 4xx `status`.
    const status = (error as { status?: unknown }).status;
    if (error instanceof SyntaxError && typeof status === "number" && status < 500) {
        return new ApiError("VALIDATION_ERROR", "Malformed JSON body");
    }
    return error as ErrorWithStatus;
};

export const errorHandlingMiddleware: ErrorRequestHandler = (error, request, response, _next) => {
    const normalizedError = normalize(error);
    const statusCode = normalizedError.statusCode ?? StatusCodes.INTERNAL_SERVER_ERROR;
    const isServerError = statusCode >= StatusCodes.INTERNAL_SERVER_ERROR;
    // Server errors may carry internal details (DB messages, file paths); never expose them in production.
    const hideDetails = env.IS_PRODUCTION && isServerError;
    const responseError = {
        statusCode,
        ...(typeof normalizedError.code === "string" && { code: normalizedError.code }),
        message: hideDetails ? "Internal Server Error" : normalizedError.message || "Internal Server Error",
        errors: hideDetails ? [] : normalizedError.errors || [],
        stack: env.IS_PRODUCTION ? null : normalizedError.stack,
    };

    if (isServerError) {
        logger.error(`[${request.method} ${request.path}] ${normalizedError.message}`, {
            stack: normalizedError.stack,
        });
    } else {
        logger.warn(`[${request.method} ${request.path}] ${statusCode} ${responseError.message}`);
    }
    response.status(statusCode).json(responseError);
};
