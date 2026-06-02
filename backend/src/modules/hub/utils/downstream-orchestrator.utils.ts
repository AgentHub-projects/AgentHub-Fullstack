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

/** 安全转换为 Record，非对象值返回 {} */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 安全提取非空字符串 */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 安全提取有限数值 */
export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Promise 版延时 */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
