import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { HubArtifactDto, HubArtifactKind, UploadedAttachmentDto } from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { asObject, mapArtifact } from "../mappers/hub.mappers";
import { stringValue } from "../utils/downstream-orchestrator.utils";

type ArtifactPayload = Record<string, unknown>;
type OssClient = {
  put: (key: string, data: Buffer) => Promise<{ name?: string; url?: string }>;
  signatureUrl?: (key: string, options?: Record<string, unknown>) => string;
};

export const TEXT_ATTACHMENT_PREVIEW_CHAR_LIMIT = 100 * 1024;

/** 产物存储服务：管理附件上传、产物增删改查、OSS 存储和版本记录 */
@Injectable()
export class ArtifactStorageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 创建用户上传的附件：必须存储到 OSS，记录 artifact 和版本 */
  async createAttachment(input: {
    sessionId: string;
    name: string;
    mimeType: string;
    data: Buffer;
  }): Promise<UploadedAttachmentDto> {
    const artifactId = randomUUID();
    const sha256 = sha256Buffer(input.data);
    const sizeBytes = input.data.length;
    const kind = inferKindFromMime(input.mimeType);
    const textPreview = buildTextAttachmentPreview(input.mimeType, input.data);
    const uploaded = await this.uploadToOss(input.sessionId, "attachments", input.name, input.data, input.mimeType);
    if (!uploaded) throw new ServiceUnavailableException("ARTIFACT_OSS_REQUIRED");
    const publicUrl = (await this.getSignedOssUrl(uploaded.uri)) ?? uploaded.uri;

    const artifact = await this.prisma.artifact.create({
      data: {
        id: artifactId,
        sessionId: input.sessionId,
        artifactKey: `attachment:${artifactId}`,
        kind,
        title: input.name,
        mimeType: input.mimeType,
        storageKind: "oss_object",
        storageUri: uploaded.uri,
        textContent: textPreview,
        sha256,
        sizeBytes: BigInt(sizeBytes),
        final: true,
        metadata: {
          attachment: true,
          originalName: input.name,
          url: publicUrl,
          textPreview,
        } as any,
      },
    });
    return {
      id: artifact.id,
      name: artifact.title,
      mimeType: artifact.mimeType,
      sizeBytes,
      sha256,
      url: publicUrl ?? "",
      textPreview,
      createdAt: artifact.createdAt.toISOString(),
    };
  }

  /** 创建或更新 artifact：支持二进制、内联文本和远程 URL，保留版本历史 */
  async upsertArtifact(input: {
    sessionId: string;
    runId: string;
    producingEventId?: string;
    payload: ArtifactPayload;
  }): Promise<HubArtifactDto | null> {
    const artifactKey = stringValue(input.payload.artifactKey) ?? stringValue(input.payload.key) ?? "artifact";
    const kind = normalizeArtifactKind(stringValue(input.payload.kind) ?? "text");
    const title = stringValue(input.payload.title) ?? artifactKey;
    const mimeType = stringValue(input.payload.mimeType) ?? inferMimeType(kind);
    const content = stringValue(input.payload.content) ?? stringValue(input.payload.text) ?? null;
    const final = Boolean(input.payload.final ?? false);

    const binary = decodeBinary(input.payload);
    const remoteUrl =
      stringValue(input.payload.url) ??
      stringValue(input.payload.storageUri) ??
      stringValue(input.payload.uri) ??
      stringValue(input.payload.remoteUrl);
    const metadata = mergeUrlMetadata(asObject(input.payload.metadata), remoteUrl);
    let storageKind: "inline_text" | "oss_object" | "remote_url" = "inline_text";
    let storageUri: string | null = null;
    let textContent: string | null = content;
    let sha256: string | null = content ? sha256Text(content) : null;
    let sizeBytes: bigint | null = content ? BigInt(Buffer.byteLength(content)) : null;

    if (binary) {
      const uploaded = await this.uploadToOss(input.sessionId, input.runId, artifactKey, binary, mimeType);
      if (!uploaded) throw new ServiceUnavailableException("ARTIFACT_OSS_REQUIRED");
      storageKind = "oss_object";
      storageUri = uploaded.uri;
      textContent = null;
      sha256 = uploaded.sha256;
      sizeBytes = BigInt(binary.length);
    } else if (!content && remoteUrl) {
      storageKind = remoteUrl.startsWith("oss://") ? "oss_object" : "remote_url";
      storageUri = remoteUrl;
      textContent = null;
      sha256 = stringValue(input.payload.sha256) ?? null;
      sizeBytes = bigintValue(input.payload.sizeBytes);
    }

    const artifact = await this.prisma.artifact.upsert({
      where: {
        runId_artifactKey: {
          runId: input.runId,
          artifactKey,
        },
      },
      create: {
        sessionId: input.sessionId,
        runId: input.runId,
        producingEventId: input.producingEventId,
        artifactKey,
        kind,
        title,
        mimeType,
        storageKind,
        storageUri,
        textContent,
        sha256,
        sizeBytes,
        final,
        metadata: metadata as any,
      },
      update: {
        producingEventId: input.producingEventId,
        kind,
        title,
        mimeType,
        storageKind,
        storageUri,
        textContent,
        sha256,
        sizeBytes,
        final,
        metadata: metadata as any,
      },
    });

    return mapArtifact(artifact);
  }

  /** 追加 delta 内容到已有 artifact（简化版 chunk 累积） */
  async storeChunk(input: {
    sessionId: string;
    runId: string;
    producingEventId?: string;
    payload: ArtifactPayload;
  }) {
    // Chunked artifacts simplified: just accumulate content text
    const artifactKey = stringValue(input.payload.artifactKey) ?? "artifact";
    const delta = stringValue(input.payload.data) ?? stringValue(input.payload.text) ?? "";

    if (!delta) return null;

    const existing = await this.prisma.artifact.findUnique({
      where: { runId_artifactKey: { runId: input.runId, artifactKey } },
    });

    if (existing) {
      const updated = await this.prisma.artifact.update({
        where: { id: existing.id },
        data: {
          textContent: (existing.textContent ?? "") + delta,
          sizeBytes: BigInt(((existing.textContent ?? "").length + delta.length)),
          producingEventId: input.producingEventId,
          },
      });
      return mapArtifact(updated);
    }

    return this.upsertArtifact({
      sessionId: input.sessionId,
      runId: input.runId,
      producingEventId: input.producingEventId,
      payload: {
        artifactKey,
        kind: input.payload.kind ?? "text",
        title: input.payload.title ?? artifactKey,
        mimeType: input.payload.mimeType ?? "text/plain; charset=utf-8",
        content: delta,
        final: false,
        metadata: input.payload.metadata,
      },
    });
  }

  /** 标记 artifact 为完成状态 */
  async completeArtifact(input: {
    sessionId: string;
    runId: string;
    producingEventId?: string;
    payload: ArtifactPayload;
  }): Promise<HubArtifactDto | null> {
    const artifactKey = stringValue(input.payload.artifactKey) ?? "artifact";
    const existing = await this.prisma.artifact.findUnique({
      where: { runId_artifactKey: { runId: input.runId, artifactKey } },
    });

    if (!existing) {
      return this.upsertArtifact({
        sessionId: input.sessionId,
        runId: input.runId,
        producingEventId: input.producingEventId,
        payload: { ...input.payload, final: true },
      });
    }

    const updated = await this.prisma.artifact.update({
      where: { id: existing.id },
      data: {
        final: true,
        producingEventId: input.producingEventId,
      },
    });
    return mapArtifact(updated);
  }

  /** 列出 artifact 的所有版本 */
  /** 获取 artifact 内容：内联文本直接返回，OSS 返回签名重定向 URL */
  async getContent(artifactId: string) {
    const artifact = await this.prisma.artifact.findUnique({ where: { id: artifactId } });
    if (!artifact) return null;
    if (artifact.storageKind === "inline_text") {
      return {
        artifact: mapArtifact(artifact),
        body: artifact.textContent ?? "",
        contentType: artifact.mimeType,
      };
    }
    if (artifact.storageKind === "oss_object" && artifact.storageUri) {
      return {
        artifact: mapArtifact(artifact),
        redirectUrl: await this.getSignedOssUrl(artifact.storageUri),
        contentType: artifact.mimeType,
      };
    }
    return {
      artifact: mapArtifact(artifact),
      redirectUrl: artifact.storageUri ?? undefined,
      contentType: artifact.mimeType,
    };
  }

  /** 获取上传内容：附件与产物统一走 OSS 或内联内容 */
  async getUploadedContent(artifactId: string) {
    return this.getContent(artifactId);
  }

  /** 上传文件到阿里云 OSS */
  private async uploadToOss(
    sessionId: string,
    runId: string,
    artifactKey: string,
    data: Buffer,
    mimeType: string,
  ): Promise<{ uri: string; sha256: string } | null> {
    const bucket = process.env.ALIYUN_OSS_BUCKET;
    const region = process.env.ALIYUN_OSS_REGION;
    const accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
    if (!bucket || !region || !accessKeyId || !accessKeySecret) return null;

    const prefix = process.env.ARTIFACT_OSS_PREFIX ?? "agenthub/artifacts";
    const objectKey = `${prefix}/${sessionId}/${runId}/${Date.now()}-${safeKey(artifactKey)}`;
    const client = await this.createOssClient();
    if (!client) return null;

    await client.put(objectKey, data);
    return {
      uri: `oss://${bucket}/${objectKey}`,
      sha256: sha256Buffer(data),
    };
  }

  /** 获取 OSS 签名 URL，过期时间 600 秒 */
  private async getSignedOssUrl(storageUri: string): Promise<string | undefined> {
    const bucket = process.env.ALIYUN_OSS_BUCKET;
    const publicDomain = process.env.ALIYUN_OSS_PUBLIC_DOMAIN?.replace(/\/$/, "");
    const objectKey = storageUri.replace(/^oss:\/\/[^/]+\//, "");
    const client = await this.createOssClient();
    if (client?.signatureUrl) {
      return client.signatureUrl(objectKey, { expires: 600 });
    }
    if (bucket && publicDomain) {
      return `${publicDomain}/${objectKey}`;
    }
    return undefined;
  }

  /** 懒加载创建阿里云 OSS 客户端 */
  private async createOssClient(): Promise<OssClient | null> {
    const bucket = process.env.ALIYUN_OSS_BUCKET;
    const region = process.env.ALIYUN_OSS_REGION;
    const accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
    if (!bucket || !region || !accessKeyId || !accessKeySecret) return null;
    const mod = (await import("ali-oss")) as { default?: new (options: Record<string, unknown>) => OssClient };
    const Client = mod.default;
    if (!Client) return null;
    return new Client({
      region,
      bucket,
      accessKeyId,
      accessKeySecret,
      endpoint: process.env.ALIYUN_OSS_ENDPOINT,
    });
  }

  /** 上传头像到 OSS，返回公开 URL */
  async uploadAvatar(userId: string, data: Buffer, mimeType?: string): Promise<string | null> {
    const bucket = process.env.ALIYUN_OSS_BUCKET;
    const region = process.env.ALIYUN_OSS_REGION;
    const accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
    if (!bucket || !region || !accessKeyId || !accessKeySecret) return null;

    const ext = mimeType ? mimeType.split("/").pop() ?? "png" : "png";
    const objectKey = `agenthub/avatars/${userId}-${Date.now()}.${ext}`;
    const client = await this.createOssClient();
    if (!client) return null;

    await client.put(objectKey, data);
    const ossRegion = region.startsWith("oss-") ? region : `oss-${region}`;
    return `https://${bucket}.${ossRegion}.aliyuncs.com/${objectKey}`;
  }

  /** 在 artifact_versions 表中插入或更新版本记录 */
}

function bigintValue(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return BigInt(Math.floor(value));
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function mergeUrlMetadata(metadata: Record<string, unknown>, url?: string) {
  if (!url || typeof metadata.url === "string") return metadata;
  return { ...metadata, url };
}

function normalizeArtifactKind(value: string): HubArtifactKind {
  const normalized = value.toLowerCase();
  if (normalized === "ppt" || normalized === "presentation") return "pptx";
  const allowed = new Set(["markdown", "text", "html", "pdf", "docx", "pptx", "image", "archive", "log", "other"]);
  return allowed.has(normalized) ? (normalized as HubArtifactKind) : "other";
}

function inferMimeType(kind: HubArtifactKind): string {
  const map: Record<HubArtifactKind, string> = {
    markdown: "text/markdown; charset=utf-8",
    text: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    image: "image/png",
    archive: "application/zip",
    log: "text/plain; charset=utf-8",
    other: "application/octet-stream",
  };
  return map[kind];
}

function inferKindFromMime(mimeType: string): HubArtifactKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.includes("wordprocessingml")) return "docx";
  if (mimeType.includes("presentationml") || mimeType === "application/vnd.ms-powerpoint") return "pptx";
  if (mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("xml")) return "text";
  return "other";
}

/** 对文本类 MIME 生成预览，超过 100KB 则返回 null */
export function buildTextAttachmentPreview(mimeType: string, data: Buffer) {
  if (!mimeType.startsWith("text/") && !mimeType.includes("json") && !mimeType.includes("xml")) return null;
  const text = data.toString("utf8");
  if (text.length > TEXT_ATTACHMENT_PREVIEW_CHAR_LIMIT) return null;
  return text;
}

/** 从 payload 中解码 base64 二进制数据 */
function decodeBinary(payload: ArtifactPayload): Buffer | null {
  const dataBase64 = stringValue(payload.dataBase64) ?? stringValue(payload.base64);
  if (dataBase64) return Buffer.from(dataBase64, "base64");
  const data = stringValue(payload.data);
  const encoding = stringValue(payload.encoding);
  if (data && encoding === "base64") return Buffer.from(data, "base64");
  return null;
}

/** 计算文本的 SHA-256 哈希 */
function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 计算 Buffer 的 SHA-256 哈希 */
function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 清理字符串，仅保留字母数字和 . _ - */
function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}
