import { NextResponse } from "next/server";

const DOWNSTREAM_FILESYSTEM_ORIGIN =
  process.env.DOWNSTREAM_FILESYSTEM_ORIGIN?.replace(/\/$/, "") ?? "http://115.33.108.104:31056";

type RouteContext = {
  params: Promise<{
    sessionId: string;
    path: string[];
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { sessionId, path } = await context.params;
  const normalizedPath = path.map(encodeURIComponent).join("/");
  const url = `${DOWNSTREAM_FILESYSTEM_ORIGIN}/filesystem/download/${normalizedPath}?sessionId=${encodeURIComponent(sessionId)}`;
  const response = await fetch(url, { cache: "no-store" });
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "no-store");

  const contentType = contentTypeFromPath(path[path.length - 1] ?? "");
  if (contentType !== "application/octet-stream") headers.set("Content-Type", contentType);

  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function contentTypeFromPath(path: string) {
  const ext = path.includes(".") ? path.split(".").pop()?.toLowerCase() : "";
  if (ext === "html" || ext === "htm") return "text/html; charset=utf-8";
  if (ext === "css") return "text/css; charset=utf-8";
  if (ext === "js" || ext === "mjs") return "text/javascript; charset=utf-8";
  if (ext === "json") return "application/json; charset=utf-8";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}
