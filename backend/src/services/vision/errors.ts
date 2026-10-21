import { ApiError } from "../../utils/errors";

/** AI errors carry a retryable hint the agent uses to decide between retrying and escalating. */
export const aiError = (message: string, retryable: boolean) => new ApiError("AI_ERROR", message, [{ retryable }]);
