import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { ApiError } from "../utils/errors";

/**
 * Storage abstraction. Keys are opaque, slash-separated strings (e.g. "media/shop-1/abc.mp4").
 * The local implementation can be swapped for an S3-compatible one without touching callers.
 */
export interface StorageService {
    /** Move a file that is already on local disk (e.g. a multer temp file) into storage. */
    importFile(sourcePath: string, key: string): Promise<void>;
    writeBuffer(key: string, data: Buffer): Promise<void>;
    readBuffer(key: string): Promise<Buffer>;
    createReadStream(key: string): fs.ReadStream;
    exists(key: string): Promise<boolean>;
    size(key: string): Promise<number>;
    delete(key: string): Promise<void>;
    /** Local filesystem path for tools that need one (FFmpeg). Remote stores would download to a temp file. */
    localPath(key: string): string;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

/** Reduce an arbitrary identifier to a filesystem-safe path segment. */
export const safeSegment = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "_";

export class LocalStorageService implements StorageService {
    constructor(private readonly root: string) {}

    localPath(key: string): string {
        if (!KEY_PATTERN.test(key) || key.split("/").some((part) => part === "..")) {
            throw new ApiError("VALIDATION_ERROR", "Invalid storage key");
        }
        const resolved = path.resolve(this.root, ...key.split("/"));
        // Defense in depth against traversal: the resolved path must stay under the storage root.
        if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
            throw new ApiError("FORBIDDEN", "Storage key escapes the storage root");
        }
        return resolved;
    }

    async importFile(sourcePath: string, key: string): Promise<void> {
        const target = this.localPath(key);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        try {
            await fsp.rename(sourcePath, target);
        } catch {
            // rename fails across devices; fall back to copy + delete.
            await fsp.copyFile(sourcePath, target);
            await fsp.rm(sourcePath, { force: true });
        }
    }

    async writeBuffer(key: string, data: Buffer): Promise<void> {
        const target = this.localPath(key);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, data);
    }

    readBuffer(key: string): Promise<Buffer> {
        return fsp.readFile(this.localPath(key));
    }

    createReadStream(key: string): fs.ReadStream {
        return fs.createReadStream(this.localPath(key));
    }

    async exists(key: string): Promise<boolean> {
        try {
            await fsp.access(this.localPath(key), fs.constants.R_OK);
            return true;
        } catch {
            return false;
        }
    }

    async size(key: string): Promise<number> {
        return (await fsp.stat(this.localPath(key))).size;
    }

    async delete(key: string): Promise<void> {
        await fsp.rm(this.localPath(key), { force: true });
    }
}

let instance: StorageService | undefined;

export const storage = (): StorageService => {
    instance ??= new LocalStorageService(env.uploadDirAbs);
    return instance;
};

/** Temp directory for in-flight uploads, inside the upload root. */
export const uploadTempDir = (): string => path.join(env.uploadDirAbs, "tmp");
