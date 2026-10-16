import express from "express";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import cors from "cors";
import helmet from "helmet";
import "./types/auth";
import { env } from "./config/env";
import { errorHandlingMiddleware } from "./middleware/errorHandlingMiddleware";
import apiRoutes from "./routes/api";
import { ApiError } from "./utils/errors";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
if (env.NODE_ENV !== "test") app.use(morgan("dev"));
// Chỉ cho phép frontend đã cấu hình gửi kèm cookie xác thực
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(cookieParser());

app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", message: "API is healthy" });
});

app.use("/api", (request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
});

app.use("/api", apiRoutes);
app.use("/api", (request, _response, next) => {
    next(new ApiError("NOT_FOUND", `Route ${request.method} ${request.originalUrl} not found`));
});
app.use(errorHandlingMiddleware);

export default app;
