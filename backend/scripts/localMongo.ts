/**
 * Development helper: runs a real mongod (downloaded by mongodb-memory-server on first use)
 * on 127.0.0.1:27017 with data persisted in backend/.mongo-data. For machines without MongoDB or Docker.
 */
import fs from "node:fs";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";

const dbPath = path.resolve(".mongo-data");
fs.mkdirSync(dbPath, { recursive: true });

const port = Number(process.env.LOCAL_MONGO_PORT ?? 27017);
const server = await MongoMemoryServer.create({
    instance: { port, ip: "127.0.0.1", dbPath, storageEngine: "wiredTiger" },
});

console.info(`Local MongoDB running at ${server.getUri()} (data: ${dbPath})`);
console.info(`Use MONGODB_URI=mongodb://127.0.0.1:${port}/fixit. Press Ctrl+C to stop.`);

const shutdown = async () => {
    await server.stop({ doCleanup: false });
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
