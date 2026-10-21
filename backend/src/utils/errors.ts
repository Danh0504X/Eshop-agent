import { StatusCodes } from "http-status-codes";

export type ErrorCode =
    | "VALIDATION_ERROR"
    | "UNAUTHENTICATED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "PAYLOAD_TOO_LARGE"
    | "UNSUPPORTED_MEDIA_TYPE"
    | "RATE_LIMITED"
    | "APPROVAL_REQUIRED"
    | "INVALID_STATE"
    | "BUDGET_EXHAUSTED"
    | "DUPLICATE_SEGMENT"
    | "PROCESSING_ERROR"
    | "AI_ERROR"
    | "INTERNAL_ERROR";

const STATUS: Record<ErrorCode, number> = {
    VALIDATION_ERROR: StatusCodes.BAD_REQUEST,
    UNAUTHENTICATED: StatusCodes.UNAUTHORIZED,
    FORBIDDEN: StatusCodes.FORBIDDEN,
    NOT_FOUND: StatusCodes.NOT_FOUND,
    CONFLICT: StatusCodes.CONFLICT,
    PAYLOAD_TOO_LARGE: StatusCodes.REQUEST_TOO_LONG,
    UNSUPPORTED_MEDIA_TYPE: StatusCodes.UNSUPPORTED_MEDIA_TYPE,
    RATE_LIMITED: StatusCodes.TOO_MANY_REQUESTS,
    APPROVAL_REQUIRED: StatusCodes.FORBIDDEN,
    INVALID_STATE: StatusCodes.CONFLICT,
    BUDGET_EXHAUSTED: StatusCodes.CONFLICT,
    DUPLICATE_SEGMENT: StatusCodes.CONFLICT,
    PROCESSING_ERROR: StatusCodes.UNPROCESSABLE_ENTITY,
    AI_ERROR: StatusCodes.BAD_GATEWAY,
    INTERNAL_ERROR: StatusCodes.INTERNAL_SERVER_ERROR,
};

/** Shape consumed by errorHandlingMiddleware: statusCode + string code + optional errors list. */
export class ApiError extends Error {
    readonly statusCode: number;
    readonly errors: unknown[];

    constructor(
        readonly code: ErrorCode,
        message: string,
        errors: unknown[] = [],
    ) {
        super(message);
        this.name = "ApiError";
        this.statusCode = STATUS[code];
        this.errors = errors;
    }
}

export const notFound = (what: string) => new ApiError("NOT_FOUND", `${what} not found`);
export const forbidden = (message = "You do not have access to this resource") => new ApiError("FORBIDDEN", message);

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
