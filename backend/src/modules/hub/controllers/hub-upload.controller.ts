import { BadRequestException, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { PublicRoute } from "../auth/public.decorator";
import { ArtifactStorageService } from "../services/artifact-storage.service";
import { PrismaService } from "../services/prisma.service";
import { assertSessionActive } from "./controller-guards";
import {
  decodeHeaderValue,
  headerString,
  MAX_UPLOAD_BYTES,
  readRequestBuffer,
} from "./request-utils";

/** 上传控制器：处理文件上传和获取上传内容 */
@Controller()
export class HubUploadController {
  constructor(
    @Inject(ArtifactStorageService) private readonly artifacts: ArtifactStorageService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** 上传附件到会话（最大 50MB） */
  @Post("sessions/:sessionId/uploads")
  async uploadAttachment(@Param("sessionId") sessionId: string, @Req() request: Request) {
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (!sessionId) throw new BadRequestException("SESSION_ID_REQUIRED");
    await assertSessionActive(this.prisma, sessionId);
    if (contentLength > MAX_UPLOAD_BYTES) throw new BadRequestException("UPLOAD_TOO_LARGE");
    const data = await readRequestBuffer(request, MAX_UPLOAD_BYTES);
    if (data.length === 0) throw new BadRequestException("UPLOAD_EMPTY");
    const name = decodeHeaderValue(headerString(request.headers["x-file-name"]) ?? "attachment");
    const mimeType = headerString(request.headers["content-type"]) ?? "application/octet-stream";
    return this.artifacts.createAttachment({ sessionId, name, mimeType, data });
  }

  /** 获取上传内容（公开访问） */
  @PublicRoute()
  @Get("uploads/:artifactId/content")
  async getUploadedContent(@Param("artifactId") artifactId: string, @Res() response: Response) {
    const content = await this.artifacts.getUploadedContent(artifactId);
    if (!content) {
      response.status(404).json({ code: "NOT_FOUND", message: "Upload not found" });
      return;
    }
    if ("redirectUrl" in content && content.redirectUrl) {
      response.redirect(content.redirectUrl);
      return;
    }
    response.type(content.contentType).send(content.body ?? "");
  }
}
