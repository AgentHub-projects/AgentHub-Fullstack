import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { Inject, Injectable } from "@nestjs/common";
import type { HubArtifactDto, HubArtifactKind } from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { asObject, mapArtifact } from "./hub.mappers";

type ArtifactPayload = Record<string, unknown>;
type OssClient = {
  put: (key: string, data: Buffer) => Promise<{ name?: string; url?: string }>;
  signatureUrl?: (key: string, options?: Record<string, unknown>) => string;
};

@Injectable()
export class ArtifactStorageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
    const metadata = asObject(input.payload.metadata);
    let storageKind: "inline_text" | "oss_object" = "inline_text";
    let storageUri: string | null = null;
    let textContent: string | null = content;
    let sha256: string | null = content ? sha256Text(content) : null;
    let sizeBytes: bigint | null = content ? BigInt(Buffer.byteLength(content)) : null;

    if (binary) {
      const uploaded = await this.uploadToOss(input.sessionId, input.runId, artifactKey, binary, mimeType);
      if (uploaded) {
        storageKind = "oss_object";
        storageUri = uploaded.uri;
        textContent = null;
        sha256 = uploaded.sha256;
        sizeBytes = BigInt(binary.length);
      } else {
        textContent = binary.toString("base64");
        sha256 = sha256Buffer(binary);
        sizeBytes = BigInt(binary.length);
      }
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
        version: { increment: 1 },
      },
    });

    return mapArtifact(artifact);
  }

  async storeChunk(input: {
    sessionId: string;
    runId: string;
    producingEventId?: string;
    payload: ArtifactPayload;
  }) {
    const artifact = await this.upsertArtifact({
      sessionId: input.sessionId,
      runId: input.runId,
      producingEventId: input.producingEventId,
      payload: {
        artifactKey: input.payload.artifactKey,
        kind: input.payload.kind ?? "other",
        title: input.payload.title ?? input.payload.artifactKey,
        mimeType: input.payload.mimeType,
        metadata: input.payload.metadata,
        final: false,
      },
    });
    if (!artifact) return null;

    await this.prisma.artifactChunk.upsert({
      where: {
        artifactId_chunkIndex: {
          artifactId: artifact.id,
          chunkIndex: numberValue(input.payload.chunkIndex) ?? 0,
        },
      },
      create: {
        artifactId: artifact.id,
        chunkIndex: numberValue(input.payload.chunkIndex) ?? 0,
        encoding: stringValue(input.payload.encoding) ?? "base64",
        data: stringValue(input.payload.data) ?? "",
      },
      update: {
        encoding: stringValue(input.payload.encoding) ?? "base64",
        data: stringValue(input.payload.data) ?? "",
      },
    });
    return artifact;
  }

  async completeArtifact(input: {
    sessionId: string;
    runId: string;
    producingEventId?: string;
    payload: ArtifactPayload;
  }): Promise<HubArtifactDto | null> {
    const artifactKey = stringValue(input.payload.artifactKey) ?? "artifact";
    const artifact = await this.prisma.artifact.findUnique({
      where: { runId_artifactKey: { runId: input.runId, artifactKey } },
      include: { chunks: { orderBy: { chunkIndex: "asc" } } },
    });
    if (!artifact) {
      return this.upsertArtifact({
        sessionId: input.sessionId,
        runId: input.runId,
        producingEventId: input.producingEventId,
        payload: { ...input.payload, final: true },
      });
    }

    if (artifact.chunks.length === 0) {
      const updated = await this.prisma.artifact.update({
        where: { id: artifact.id },
        data: { final: true, producingEventId: input.producingEventId },
      });
      return mapArtifact(updated);
    }

    const binary = Buffer.concat(
      artifact.chunks.map((chunk) =>
        chunk.encoding === "utf8" ? Buffer.from(chunk.data, "utf8") : Buffer.from(chunk.data, "base64"),
      ),
    );
    const uploaded = await this.uploadToOss(
      input.sessionId,
      input.runId,
      artifactKey,
      binary,
      stringValue(input.payload.mimeType) ?? artifact.mimeType,
    );

    const updated = await this.prisma.artifact.update({
      where: { id: artifact.id },
      data: {
        final: true,
        producingEventId: input.producingEventId,
        storageKind: uploaded ? "oss_object" : "inline_text",
        storageUri: uploaded?.uri ?? artifact.storageUri,
        textContent: uploaded ? null : binary.toString("base64"),
        sha256: uploaded?.sha256 ?? sha256Buffer(binary),
        sizeBytes: BigInt(binary.length),
      },
    });
    return mapArtifact(updated);
  }

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
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeArtifactKind(value: string): HubArtifactKind {
  const allowed = new Set(["markdown", "text", "html", "pdf", "docx", "image", "archive", "log", "other"]);
  return allowed.has(value) ? (value as HubArtifactKind) : "other";
}

function inferMimeType(kind: HubArtifactKind): string {
  const map: Record<HubArtifactKind, string> = {
    markdown: "text/markdown; charset=utf-8",
    text: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    image: "image/png",
    archive: "application/zip",
    log: "text/plain; charset=utf-8",
    other: "application/octet-stream",
  };
  return map[kind];
}

function decodeBinary(payload: ArtifactPayload): Buffer | null {
  const dataBase64 = stringValue(payload.dataBase64) ?? stringValue(payload.base64);
  if (dataBase64) return Buffer.from(dataBase64, "base64");
  const data = stringValue(payload.data);
  const encoding = stringValue(payload.encoding);
  if (data && encoding === "base64") return Buffer.from(data, "base64");
  return null;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}
