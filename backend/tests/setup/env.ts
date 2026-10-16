import os from "node:os";
import path from "node:path";

// Must run before any src module loads: src/config/env.ts validates process.env at import time.
process.env.NODE_ENV = "test";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:1/unused-tests-connect-explicitly";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-0123456789";
process.env.DEMO_MODE = "true";
process.env.AI_PROVIDER = "demo";
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `fixit-test-uploads-${process.pid}`);
process.env.MAX_UPLOAD_SIZE_MB = "20";
