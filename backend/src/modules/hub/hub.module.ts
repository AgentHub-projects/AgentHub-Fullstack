import { Module } from "@nestjs/common";
import { AgentTemplateController } from "./controllers/agent-template.controller";
import { BuilderController } from "./controllers/builder.controller";
import {
  HubAgentController,
  HubArtifactController,
  HubHealthController,
  HubSessionController,
} from "./controllers/hub.controller";
import { HubRealtimeGateway } from "./gateways/hub-realtime.gateway";
import { AgentRegistryService } from "./services/agent-registry.service";
import { AgentTemplateService } from "./services/agent-template.service";
import { ArtifactStorageService } from "./services/artifact-storage.service";
import { BuilderService } from "./services/builder.service";
import { HubContextService } from "./services/context.service";
import { DownstreamOrchestratorService } from "./services/downstream-orchestrator.service";
import { HubEventService } from "./services/event.service";
import { HubSessionService } from "./services/hub-session.service";
import { PrismaService } from "./services/prisma.service";

@Module({
  controllers: [
    HubHealthController,
    HubAgentController,
    HubArtifactController,
    HubSessionController,
    BuilderController,
    AgentTemplateController,
  ],
  providers: [
    PrismaService,
    AgentRegistryService,
    AgentTemplateService,
    BuilderService,
    HubContextService,
    ArtifactStorageService,
    HubRealtimeGateway,
    HubEventService,
    DownstreamOrchestratorService,
    HubSessionService,
  ],
})
export class HubModule {}
