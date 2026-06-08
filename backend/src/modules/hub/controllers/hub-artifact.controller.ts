import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { ArtifactStorageService } from "../services/artifact-storage.service";

/** 产物控制器：获取产物内容和版本列表 */
@Controller("artifacts")
export class HubArtifactController {
  constructor(@Inject(ArtifactStorageService) private readonly artifacts: ArtifactStorageService) {}

  /** 获取产物内容：内联返回或 OSS 重定向 */
  @Get(":artifactId/content")
  async getArtifactContent(@Param("artifactId") artifactId: string, @Res() response: Response) {
    const content = await this.artifacts.getContent(artifactId);
    if (!content) {
      response.status(404).json({ code: "NOT_FOUND", message: "Artifact not found" });
      return;
    }
    if (content.redirectUrl) {
      response.redirect(content.redirectUrl);
      return;
    }
    response.type(content.contentType).send(content.body ?? "");
  }

}
