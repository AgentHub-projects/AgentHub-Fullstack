import { Body, Controller, Get, Param, Post } from "@nestjs/common";

const emptyList = { items: [] };

@Controller()
export class StubController {
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
  listAgents() {
    return {
      items: [
        {
          id: "claude",
          name: "Claude",
          provider: "anthropic",
          role: "coding-agent"
        }
      ]
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
