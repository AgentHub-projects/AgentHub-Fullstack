import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AgentHubAuthGuard } from "./auth/auth.guard";
import { AuthSessionService } from "./auth/auth-session.service";
import { AuthController } from "./controllers/auth.controller";
import { AgentTemplateController } from "./controllers/agent-template.controller";
import { BuilderController } from "./controllers/builder.controller";
import {
  DownstreamController,
  HubAgentController,
  HubArtifactController,
  HubHealthController,
  HubSandboxController,
  HubSessionController,
  HubUploadController,
  ProjectController,
  SandboxCallbackController,
} from "./controllers/hub.controller";
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
import { SandboxService } from "./services/sandbox.service";

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
    SandboxCallbackController,
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
    DeploymentService,
    HubSessionService,
    SandboxService,
  ],
})
export class HubModule {}
