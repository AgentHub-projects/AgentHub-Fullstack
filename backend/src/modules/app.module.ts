import { Module } from "@nestjs/common";
import { AgentRegistryService } from "../hub/agent-registry.service";
import { AgentTemplateService } from "../hub/agent-template.service";
import { ArtifactStorageService } from "../hub/artifact-storage.service";
import { BuilderService } from "../hub/builder.service";
import { HubContextService } from "../hub/context.service";
import { DownstreamOrchestratorService } from "../hub/downstream-orchestrator.service";
import { HubEventService } from "../hub/event.service";
import { AgentTemplateController } from "../hub/agent-template.controller";
import { BuilderController } from "../hub/builder.controller";
import {
  HubAgentController,
  HubArtifactController,
  HubHealthController,
  HubSessionController,
} from "../hub/hub.controller";
import { HubRealtimeGateway } from "../hub/hub-realtime.gateway";
import { HubSessionService } from "../hub/hub-session.service";
import { PrismaService } from "../hub/prisma.service";

@Module({
  controllers: [
    HubHealthController,
    HubAgentController,
    HubArtifactController,
    HubSessionController,
    AgentTemplateController,
    BuilderController,
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
export class AppModule {}
