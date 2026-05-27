import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { PrismaService } from "../services/prisma.service";

const emptyList = { items: [] };

@Controller()
export class StubController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get("conversations")
  listConversations() {
    return emptyList;
  }

  @Get("conversations/:conversationId/messages")
  listMessages(@Param("conversationId") conversationId: string) {
    return { conversationId, items: [] };
  }

  @Post("conversations/:conversationId/messages")
  createMessage(@Param("conversationId") conversationId: string, @Body() body: unknown) {
    return { conversationId, message: body };
  }

  @Get("agents")
  async listAgents() {
    const agents = await this.prisma.agentDefinition.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });

    return {
      items: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        provider: agent.provider,
        role: agent.role,
        description: agent.description ?? undefined
      }))
    };
  }

  @Get("pinned-context")
  listPinnedContext() {
    return emptyList;
  }

  @Post("pinned-context")
  createPinnedContext(@Body() body: unknown) {
    return { item: body };
  }

  @Get("artifacts")
  listArtifacts() {
    return emptyList;
  }

  @Post("code-apply")
  applyCode(@Body() body: unknown) {
    return {
      accepted: false,
      reason: "P0 backend stub only; code apply is not implemented yet.",
      request: body
    };
  }
}
