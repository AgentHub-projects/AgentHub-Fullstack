import { Body, Controller, Get, Post } from "@nestjs/common";

const emptyList = { items: [] };

@Controller()
export class StubController {
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
