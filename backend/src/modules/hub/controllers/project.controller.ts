import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import type { CreateProjectRequest, UpdateProjectRequest } from "@agenthub/shared";
import { mapProject } from "../mappers/hub.mappers";
import { PrismaService } from "../services/prisma.service";

/** 项目控制器：管理项目的 CRUD */
@Controller("projects")
export class ProjectController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 列出活跃项目 */
  @Get()
  async listProjects() {
    const items = await this.prisma.project.findMany({
      where: { status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    return { items: items.map(mapProject) };
  }

  /** 创建项目 */
  @Post()
  async createProject(@Body() body: CreateProjectRequest) {
    const name = body?.name?.trim();
    const githubUrl = body?.githubUrl?.trim();
    if (!name || !githubUrl) throw new BadRequestException("PROJECT_NAME_AND_GITHUB_URL_REQUIRED");
    const project = await this.prisma.project.create({
      data: {
        name,
        githubUrl,
        defaultBranch: body.defaultBranch?.trim() || "main",
      },
    });
    return mapProject(project);
  }

  /** 更新项目字段 */
  @Patch(":projectId")
  async updateProject(@Param("projectId") projectId: string, @Body() body: UpdateProjectRequest) {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.githubUrl !== undefined ? { githubUrl: body.githubUrl.trim() } : {}),
        ...(body.defaultBranch !== undefined ? { defaultBranch: body.defaultBranch.trim() || "main" } : {}),
      },
    });
    return mapProject(project);
  }

  /** 软删除项目 */
  @Delete(":projectId")
  async deleteProject(@Param("projectId") projectId: string) {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: "deleted" },
    });
    return { ok: true };
  }
}
