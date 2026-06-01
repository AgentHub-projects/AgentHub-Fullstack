import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export const AUTH_COOKIE_NAME = "agenthub_session";
export const AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_MAX_AGE_SECONDS = AUTH_MAX_AGE_MS / 1000;

const scrypt = promisify(scryptCallback);

export function authCookieToken(cookieHeader: string | string[] | undefined) {
  return parseCookieHeader(cookieHeader)[AUTH_COOKIE_NAME] ?? null;
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [scheme, salt, hash] = storedHash.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = await hashPassword(password, salt);
  return safeEqual(candidate, storedHash);
}

export function parseCookieHeader(cookieHeader: string | string[] | undefined) {
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
