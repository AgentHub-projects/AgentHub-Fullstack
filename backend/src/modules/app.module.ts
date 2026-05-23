import { Module } from "@nestjs/common";
import { AgentRunner } from "../services/agent-runner.service";
import { AgentEventsGateway } from "../realtime/agent-events.gateway";
import { HealthController } from "../controllers/health.controller";
import { SessionController } from "../controllers/session.controller";
import { StubController } from "../controllers/stub.controller";
import { SessionService } from "../services/session.service";
import { WorktreeService } from "../services/worktree.service";

@Module({
  controllers: [HealthController, SessionController, StubController],
  providers: [AgentEventsGateway, AgentRunner, SessionService, WorktreeService]
})
export class AppModule {}
