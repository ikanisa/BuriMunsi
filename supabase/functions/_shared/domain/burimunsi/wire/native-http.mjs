import { BuriError, requireThat } from "../errors.js";
import { ContractViolation, parseWire } from "./runtime.mjs";
import { MAX_NATIVE_REQUEST_BYTES, readNativeBody } from "./request-boundary.mjs";

const phonePinRecordsPath = /^\/v1\/burimunsi\/(?:home|payments(?:\/[A-Za-z0-9_-]+)?|members(?:\/[A-Za-z0-9_-]+)?)$/;
export function isPhonePinRecordRead(path, search) {
  return phonePinRecordsPath.test(path) || path === '/v1/burimunsi/session' &&
    (search === '?include=home' || search === '?include=home_savings');
}

export function requireNativeHttpsOrigin(origin) {
  const configured = new URL(origin);
  requireThat(configured.protocol === "https:" && configured.origin === origin, "tls_origin_required", 503);
}

export function nativeRequestUrl(request, origin) {
  const url = new URL(request.url);
  // Installed clients omit Origin. Browser requests must use the same origin.
  const browserOrigin = request.headers.get("origin");
  requireThat(url.origin === origin && (!browserOrigin || browserOrigin === origin), "origin_denied", 403);
  return url;
}

export async function readNativeJson(
  request,
  { strictContract = true, timeoutMs, maxBytes = MAX_NATIVE_REQUEST_BYTES } = {},
) {
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  requireThat(mediaType === "application/json", "json_required", 415);
  const bytes = await readNativeBody(request, { timeoutMs, maxBytes });
  try {
    if (strictContract) return parseWire(bytes, maxBytes);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ContractViolation) throw error;
    throw new BuriError("invalid_json", 400);
  } finally {
    bytes.fill(0);
  }
}
