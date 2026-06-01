import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AgentHubAuthGuard } from "./auth/auth.guard";
import { AuthController } from "./controllers/auth.controller";
import { AgentTemplateController } from "./controllers/agent-template.controller";
import { BuilderController } from "./controllers/builder.controller";
import {
  DownstreamController,
  HubAgentController,
  HubArtifactController,
  HubHealthController,
  HubSessionController,
  HubUploadController,
  ProjectController,
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

@Module({
  controllers: [
    AuthController,
    DownstreamController,
    HubHealthController,
    HubAgentController,
    HubArtifactController,
    HubUploadController,
    HubSessionController,
    ProjectController,
    BuilderController,
    AgentTemplateController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AgentHubAuthGuard },
    PrismaService,
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
  ],
})
export class HubModule {}
