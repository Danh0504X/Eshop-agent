import crypto from "node:crypto";
import fs from "node:fs";
import multer from "multer";
import { env } from "../config/env";
import { ALLOWED_VIDEO_TYPES } from "../services/mediaService";
import { uploadTempDir } from "../services/storageService";
import { ApiError } from "../utils/errors";

const diskStorage = multer.diskStorage({
    destination: (_request, _file, callback) => {
        const dir = uploadTempDir();
        fs.mkdirSync(dir, { recursive: true });
        callback(null, dir);
    },
    // Never trust the client filename on disk: use a random name with no extension.
    filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`),
});

export const videoUpload = multer({
    storage: diskStorage,
    limits: { fileSize: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024, files: 1, fields: 10 },
    fileFilter: (_request, file, callback) => {
        if (!ALLOWED_VIDEO_TYPES[file.mimetype]) {
            return callback(
                new ApiError("UNSUPPORTED_MEDIA_TYPE", `Unsupported file type ${file.mimetype}; upload a video`),
            );
        }
        callback(null, true);
    },
}).single("file");
