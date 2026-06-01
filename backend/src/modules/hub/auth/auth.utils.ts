import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "agenthub_session";
export const AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function configuredAccessKey() {
  return process.env.AGENTHUB_ACCESS_KEY?.trim() ?? "";
}

export function authCookieValue(accessKey = configuredAccessKey()) {
  return createHash("sha256").update(`agenthub:${accessKey}`).digest("hex");
}

export function isAccessKeyConfigured() {
  return configuredAccessKey().length > 0;
}

export function isAccessKeyValid(value: unknown) {
  const accessKey = configuredAccessKey();
  if (!accessKey || typeof value !== "string") return false;
  return safeEqual(value, accessKey);
}

export function isCookieHeaderAuthenticated(cookieHeader: string | string[] | undefined) {
  const accessKey = configuredAccessKey();
  if (!accessKey) return false;
  const cookieValue = parseCookieHeader(cookieHeader)[AUTH_COOKIE_NAME];
  return Boolean(cookieValue) && safeEqual(cookieValue, authCookieValue(accessKey));
}

function parseCookieHeader(cookieHeader: string | string[] | undefined) {
  const cookies: Record<string, string> = {};
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
