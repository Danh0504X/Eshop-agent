import { BarcodeDetector, prepareZXingModule, type BarcodeFormat } from "barcode-detector/ponyfill";
import zxingReaderWasm from "zxing-wasm/reader/zxing_reader.wasm?url";

// Serve the decoder's WebAssembly from this app instead of the library's default CDN, so scanning does not
// depend on a third-party host.
prepareZXingModule({
    overrides: {
        locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? zxingReaderWasm : prefix + path),
    },
});

/** Codes found on shipping labels: Code 128 for the tracking number, sometimes Code 39, QR or Data Matrix. */
const FORMATS: BarcodeFormat[] = ["code_128", "code_39", "code_93", "itf", "ean_13", "qr_code", "data_matrix"];

/** Same rule as the backend: letters, digits, '.', '_' and '-', at most 64 characters. */
export const TRACKING_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface DetectedCode {
    value: string;
    format: string;
    /** Whether the value can be a tracking code (a QR code holding a URL cannot). */
    valid: boolean;
}

let detector: BarcodeDetector | undefined;

/** Decode every barcode in a camera frame or an image file, de-duplicated by value. */
export const detectCodes = async (source: ImageBitmapSource): Promise<DetectedCode[]> => {
    detector ??= new BarcodeDetector({ formats: FORMATS });
    const found = new Map<string, DetectedCode>();
    for (const barcode of await detector.detect(source)) {
        const value = barcode.rawValue.trim();
        if (value && !found.has(value)) {
            found.set(value, { value, format: barcode.format, valid: TRACKING_CODE.test(value) });
        }
    }
    return [...found.values()];
};
