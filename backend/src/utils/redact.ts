/**
 * Best-effort text redaction for exported reports. Pattern-based redaction is not a guarantee,
 * so reports that use it are still marked as requiring privacy review.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 9+ digits, optionally separated by spaces, dots, dashes or parentheses, optional leading +.
const PHONE = /(?<![A-Za-z0-9])\+?\(?\d(?:[\s.()-]*\d){8,14}(?![A-Za-z0-9])/g;
// House number followed by words up to a street keyword (English and Vietnamese).
const STREET =
    /\b\d{1,5}[A-Za-z]?(?:\/\d+)?\s+(?:[\p{L}.'-]+\s+){0,5}?(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|boulevard|blvd\.?|drive|dr\.?|way|đường|phố|ngõ|hẻm)\b(?:[,\s]+(?:district|ward|quận|phường|huyện|xã)\s*[\p{L}\d]+)*/giu;
const ADMIN_AREA = /\b(?:district|ward|quận|phường|huyện)\s+[\p{L}\d]+/giu;
const LABELLED_NAME =
    /\b(recipient|customer|receiver|người nhận|khách hàng)\s*[:\-]?\s*([\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+){0,4})/gu;

export interface RedactionResult {
    text: string;
    count: number;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const redactText = (input: string, knownValues: Array<string | null | undefined> = []): RedactionResult => {
    let count = 0;
    let text = input;
    const sub = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
        text = text.replace(pattern, (...args: string[]) => {
            count++;
            return typeof replacement === "string" ? replacement : replacement(...args);
        });
    };
    for (const value of knownValues) {
        if (value && value.trim().length >= 3) sub(new RegExp(escapeRegExp(value.trim()), "gi"), "[REDACTED]");
    }
    sub(EMAIL, "[EMAIL REDACTED]");
    sub(PHONE, "[PHONE REDACTED]");
    sub(STREET, "[ADDRESS REDACTED]");
    sub(ADMIN_AREA, "[ADDRESS REDACTED]");
    sub(LABELLED_NAME, (_m, label) => `${label} [NAME REDACTED]`);
    return { text, count };
};

/** Standard PDF fonts only cover Latin-1: strip diacritics (đ→d) and drop anything else unsupported. */
export const toLatin1 = (value: string): string =>
    value
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");
