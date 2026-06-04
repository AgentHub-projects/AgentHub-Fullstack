import { BadRequestException } from "@nestjs/common";
import type { Request } from "express";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function readRequestBuffer(request: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request as any as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new BadRequestException("UPLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function headerString(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function decodeHeaderValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
