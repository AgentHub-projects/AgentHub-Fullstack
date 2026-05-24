import { Module } from "@nestjs/common";
import { AgentRunner } from "../services/agent-runner.service";
import { AgentEventsGateway } from "../realtime/agent-events.gateway";
import { AcpController, AcpService } from "../realtime/acp-server";
import { HealthController } from "../controllers/health.controller";
import { SessionController } from "../controllers/session.controller";
import { StubController } from "../controllers/stub.controller";
import { ConversationController } from "../controllers/conversation.controller";
import { AgentController } from "../controllers/agent.controller";
import { SessionService } from "../services/session.service";
import { WorktreeService } from "../services/worktree.service";
import { ConversationService } from "../services/conversation.service";
import { AgentService } from "../services/agent.service";
import { TeamService } from "../services/team.service";
import { OrchestrationService } from "../services/orchestration.service";
import { TeamController } from "../controllers/team.controller";
import { ChatService } from "../services/chat.service";
import { ChatController } from "../controllers/chat.controller";

@Module({
  controllers: [
    HealthController,
    SessionController,
    StubController,
    ConversationController,
    AgentController,
    TeamController,
    AcpController,
    ChatController,
  ],
  providers: [
    AgentEventsGateway,
    AgentRunner,
    AcpService,
    SessionService,
    WorktreeService,
    ConversationService,
    AgentService,
    TeamService,
    OrchestrationService,
    ChatService,
  ],
})
export class AppModule {}
