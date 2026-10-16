import { execFile } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { env } from "../config/env";
import { ApiError } from "../utils/errors";
import { logger } from "../utils/logger";

/**
 * Thin FFmpeg/ffprobe wrapper. Every call uses execFile with an argument array (never a shell),
 * a timeout and an output cap, so file names or model output can never inject commands.
 */

interface RunResult {
    stdout: Buffer;
    stderr: string;
}

const run = (binary: string, args: string[], timeoutMs = env.FFMPEG_TIMEOUT_MS): Promise<RunResult> =>
    new Promise((resolve, reject) => {
        execFile(
            binary,
            args,
            { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "buffer" },
            (error, stdout, stderr) => {
                if (error) {
                    const reason = (error as NodeJS.ErrnoException & { killed?: boolean }).killed
                        ? `timed out after ${timeoutMs} ms`
                        : stderr.toString("utf8").trim().split("\n").slice(-3).join(" ") || error.message;
                    reject(new ApiError("PROCESSING_ERROR", `${binaryName(binary)} failed: ${reason}`));
                    return;
                }
                resolve({ stdout, stderr: stderr.toString("utf8") });
            },
        );
    });

const binaryName = (binary: string) => (/ffprobe/i.test(binary) ? "ffprobe" : "ffmpeg");

const onPath = async (name: string): Promise<boolean> => {
    try {
        await run(name, ["-version"], 5000);
        return true;
    } catch {
        return false;
    }
};

let resolved: { ffmpeg: string; ffprobe: string } | undefined;

/** Explicit env path, then system PATH, then the bundled ffmpeg-static / ffprobe-static binaries. */
export const resolveBinaries = async (): Promise<{ ffmpeg: string; ffprobe: string }> => {
    if (resolved) return resolved;
    const ffmpeg =
        env.FFMPEG_PATH || ((await onPath("ffmpeg")) ? "ffmpeg" : ((ffmpegStatic as unknown as string | null) ?? ""));
    const ffprobe = env.FFPROBE_PATH || ((await onPath("ffprobe")) ? "ffprobe" : ffprobeStatic.path);
    if (!ffmpeg || !ffprobe) {
        throw new ApiError(
            "PROCESSING_ERROR",
            "FFmpeg/ffprobe not found. Install FFmpeg (see README) or set FFMPEG_PATH and FFPROBE_PATH.",
        );
    }
    resolved = { ffmpeg, ffprobe };
    logger.info("Video tooling resolved", resolved);
    return resolved;
};

export interface VideoProbe {
    durationSec: number;
    width: number;
    height: number;
    codec: string;
    fps: number;
}

export const probeVideo = async (filePath: string): Promise<VideoProbe> => {
    const { ffprobe } = await resolveBinaries();
    const { stdout } = await run(ffprobe, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
    ]);
    let data: {
        format?: { duration?: string };
        streams?: Array<{
            codec_type?: string;
            codec_name?: string;
            width?: number;
            height?: number;
            duration?: string;
            avg_frame_rate?: string;
        }>;
    };
    try {
        data = JSON.parse(stdout.toString("utf8"));
    } catch {
        throw new ApiError("PROCESSING_ERROR", "ffprobe returned unreadable metadata");
    }
    const video = data.streams?.find((s) => s.codec_type === "video");
    if (!video) throw new ApiError("PROCESSING_ERROR", "File contains no video stream");
    const durationSec = Number(data.format?.duration ?? video.duration);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw new ApiError("PROCESSING_ERROR", "Could not determine video duration");
    }
    const [num, den] = (video.avg_frame_rate ?? "0/1").split("/").map(Number);
    return {
        durationSec,
        width: video.width ?? 0,
        height: video.height ?? 0,
        codec: video.codec_name ?? "unknown",
        fps: den ? num / den : 0,
    };
};

/** Largest gap between consecutive video packet timestamps: a cheap signal for cuts or dropped footage. */
export const maxTimestampGap = async (filePath: string): Promise<number> => {
    const { ffprobe } = await resolveBinaries();
    const { stdout } = await run(ffprobe, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        filePath,
    ]);
    const times = stdout
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => Number(line.trim().replace(/,$/, "")))
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b);
    let gap = 0;
    for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i] - times[i - 1]);
    return gap;
};

/** Extract one JPEG frame at `timestampSec`, downscaled to at most 1024 px wide. */
export const extractFrameAt = async (filePath: string, timestampSec: number, outPath: string): Promise<void> => {
    const { ffmpeg } = await resolveBinaries();
    await run(ffmpeg, [
        "-y",
        "-v",
        "error",
        "-ss",
        timestampSec.toFixed(3),
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1024,iw)':-2",
        "-q:v",
        "3",
        outPath,
    ]);
};

export interface FrameMetrics {
    /** Mean luma, 0-255. */
    brightness: number;
    /** Variance of the Laplacian on a 160x120 grayscale thumbnail; low values mean blur. */
    sharpness: number;
}

const THUMB_W = 160;
const THUMB_H = 120;

export const frameMetrics = async (imagePath: string): Promise<FrameMetrics> => {
    const { ffmpeg } = await resolveBinaries();
    const { stdout } = await run(ffmpeg, [
        "-v",
        "error",
        "-i",
        imagePath,
        "-vf",
        `scale=${THUMB_W}:${THUMB_H},format=gray`,
        "-f",
        "rawvideo",
        "-",
    ]);
    if (stdout.length < THUMB_W * THUMB_H) throw new ApiError("PROCESSING_ERROR", "Could not decode extracted frame");
    return computeMetrics(stdout, THUMB_W, THUMB_H);
};

export const computeMetrics = (gray: Buffer, width: number, height: number): FrameMetrics => {
    let sum = 0;
    for (let i = 0; i < width * height; i++) sum += gray[i];
    const brightness = sum / (width * height);

    let lapSum = 0;
    let lapSq = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const lap = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
            lapSum += lap;
            lapSq += lap * lap;
            count++;
        }
    }
    const mean = lapSum / count;
    return { brightness, sharpness: lapSq / count - mean * mean };
};

/** Write a heavily blurred copy of an image (used for frames that may show people or personal data). */
export const blurImage = async (inputPath: string, outPath: string): Promise<void> => {
    const { ffmpeg } = await resolveBinaries();
    await run(ffmpeg, [
        "-y",
        "-v",
        "error",
        "-i",
        inputPath,
        "-vf",
        "boxblur=luma_radius=30:luma_power=4",
        "-q:v",
        "4",
        outPath,
    ]);
};
