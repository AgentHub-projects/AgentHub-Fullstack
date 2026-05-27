import { Module } from "@nestjs/common";
import { AgentRunner } from "../services/agent-runner.service";
import { AgentEventsGateway } from "../realtime/agent-events.gateway";
import { FactSourceController } from "../controllers/fact-source.controller";
import { HealthController } from "../controllers/health.controller";
import { SessionController } from "../controllers/session.controller";
import { StubController } from "../controllers/stub.controller";
import { ArtifactService } from "../services/artifact.service";
import { ContextService } from "../services/context.service";
import { EventStore } from "../services/event-store.service";
import { FACT_SOURCE_REPOSITORY } from "../services/fact-source.repository";
import { PrismaFactSourceRepository } from "../services/prisma-fact-source.repository";
import { PrismaService } from "../services/prisma.service";
import { RunStateService } from "../services/run-state.service";
import { SessionService } from "../services/session.service";
import { WorktreeService } from "../services/worktree.service";

@Module({
  controllers: [HealthController, SessionController, StubController, FactSourceController],
  providers: [
    AgentEventsGateway,
    AgentRunner,
    PrismaService,
    PrismaFactSourceRepository,
    { provide: FACT_SOURCE_REPOSITORY, useExisting: PrismaFactSourceRepository },
    EventStore,
    ArtifactService,
    ContextService,
    RunStateService,
    SessionService,
    WorktreeService
  ]
})
export class AppModule {}
