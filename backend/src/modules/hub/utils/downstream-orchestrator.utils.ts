import type { Socket } from "socket.io-client";

/** 等待 Socket.IO 连接就绪，15 秒超时 */
export function waitForSocket(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("downstream websocket connect timeout"));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
  });
}

/** 安全提取非空字符串 */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 安全提取有限数值 */
export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Promise 版延时 */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 标准化工具名称列表：去重、去空、最多 12 个 */
export function normalizeTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    .slice(0, 12);
}

/** 开发环境性能计时器 */
export async function devTimed<T>(label: string, task: () => T | Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await task();
  } finally {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[perf] ${label} ${Date.now() - started}ms`);
    }
  }
}
