import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "../utils/logger";

export const connectDB = async (uri: string = env.MONGODB_URI): Promise<void> => {
    mongoose.set("strictQuery", true);
    try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
        logger.info("Connected to MongoDB successfully.");
    } catch (error) {
        // Hide credentials embedded in the URI before surfacing the message.
        const safeUri = uri.replace(/\/\/[^@/]*@/, "//***@");
        throw new Error(
            `Could not connect to MongoDB at ${safeUri}. Start MongoDB (or run "npm run db:local" in backend/) ` +
                `and check MONGODB_URI. Cause: ${(error as Error).message}`,
        );
    }
};

export const disconnectDB = async (): Promise<void> => {
    await mongoose.disconnect();
};
