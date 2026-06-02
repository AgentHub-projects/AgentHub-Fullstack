import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/** 认证 Cookie 名称 */
export const AUTH_COOKIE_NAME = "agenthub_session";
/** 认证 Cookie 最大有效期（毫秒），默认 7 天 */
export const AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 认证 Cookie 最大有效期（秒） */
export const AUTH_MAX_AGE_SECONDS = AUTH_MAX_AGE_MS / 1000;

const scrypt = promisify(scryptCallback);

/** 从 Cookie 请求头中解析出会话 token */
export function authCookieToken(cookieHeader: string | string[] | undefined) {
  return parseCookieHeader(cookieHeader)[AUTH_COOKIE_NAME] ?? null;
}

/** 使用 scrypt 对密码进行加盐哈希，返回 scrypt$salt$hash 格式字符串 */
export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

/** 验证密码是否与存储的哈希匹配，使用时间恒定比较防止时序攻击 */
export async function verifyPassword(password: string, storedHash: string) {
  const [scheme, salt, hash] = storedHash.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = await hashPassword(password, salt);
  return safeEqual(candidate, storedHash);
}

/** 解析 Cookie 请求头为键值对对象 */
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

/** 时间恒定的字符串比较，防止时序攻击 */
function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
