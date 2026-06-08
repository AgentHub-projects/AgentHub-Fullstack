import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AgentHubAuthGuard } from "./auth/auth.guard";
import { AuthSessionService } from "./auth/auth-session.service";
import { AuthController } from "./controllers/auth.controller";
import { AgentTemplateController } from "./controllers/agent-template.controller";
import { BuilderController } from "./controllers/builder.controller";
import { DownstreamController } from "./controllers/downstream.controller";
import { HubAgentController } from "./controllers/hub-agent.controller";
import { HubArtifactController } from "./controllers/hub-artifact.controller";
import { HubHealthController } from "./controllers/hub-health.controller";
import { HubSandboxController } from "./controllers/hub-sandbox.controller";
import { HubSessionController } from "./controllers/hub-session.controller";
import { HubUploadController } from "./controllers/hub-upload.controller";
import { ProjectController } from "./controllers/project.controller";
import { HubRealtimeGateway } from "./gateways/hub-realtime.gateway";
import { AgentRegistryService } from "./services/agent-registry.service";
import { AgentTemplateService } from "./services/agent-template.service";
import { ArtifactStorageService } from "./services/artifact-storage.service";
import { BuilderService } from "./services/builder.service";
import { HubContextService } from "./services/context.service";
import { DownstreamOrchestratorService } from "./services/downstream-orchestrator.service";
import { DeploymentService } from "./services/deployment.service";
import { HubEventService } from "./services/event.service";
import { HubSessionService } from "./services/hub-session.service";
import { PrismaService } from "./services/prisma.service";
import { DownstreamSandboxRegistryService } from "./services/downstream-sandbox-registry.service";
import { PendingMessageQueueService } from "./services/pending-message-queue.service";

/** Hub 核心模块，注册所有控制器、服务、网关和全局鉴权守卫 */
@Module({
  controllers: [
    AuthController,
    DownstreamController,
    HubHealthController,
    HubAgentController,
    HubArtifactController,
    HubUploadController,
    HubSessionController,
    HubSandboxController,
    ProjectController,
    BuilderController,
    AgentTemplateController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AgentHubAuthGuard },
    PrismaService,
    AuthSessionService,
    AgentRegistryService,
    AgentTemplateService,
    BuilderService,
    HubContextService,
    ArtifactStorageService,
    HubRealtimeGateway,
    HubEventService,
    DownstreamOrchestratorService,
    DownstreamSandboxRegistryService,
    PendingMessageQueueService,
    DeploymentService,
    HubSessionService,
  ],
})
export class HubModule {}
