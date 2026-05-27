import { Module, Provider } from "@nestjs/common";
import { AgentRunner } from "../services/agent-runner.service";
import { AgentEventsGateway } from "../realtime/agent-events.gateway";
import { ArtifactService } from "../services/artifact.service";
import { ContextService } from "../services/context.service";
import { EventStore } from "../services/event-store.service";
import { FactSourceController } from "../controllers/fact-source.controller";
import { FACT_SOURCE_REPOSITORY } from "../services/fact-source.repository";
import { HealthController } from "../controllers/health.controller";
import { PrismaFactSourceRepository } from "../services/prisma-fact-source.repository";
import { PrismaService } from "../services/prisma.service";
import { RunStateService } from "../services/run-state.service";
import { SessionController } from "../controllers/session.controller";
import { SessionService } from "../services/session.service";
import { StubController } from "../controllers/stub.controller";
import { WorktreeService } from "../services/worktree.service";
import {
  DownstreamSessionManager,
  DOWNSTREAM_PERSISTENCE_TOKEN,
  DOWNSTREAM_RUN_FAILURE_SINK_TOKEN,
  type DownstreamPersistence,
  type RunFailureSink,
  PrismaDownstreamPersistence,
  type PrismaClientLike
} from "../downstream";

const downstreamPersistenceProvider: Provider = {
  provide: DOWNSTREAM_PERSISTENCE_TOKEN,
  useFactory: (prisma: PrismaService): DownstreamPersistence =>
    new PrismaDownstreamPersistence(prisma as unknown as PrismaClientLike),
  inject: [PrismaService]
};

const downstreamRunFailureSinkProvider: Provider = {
  provide: DOWNSTREAM_RUN_FAILURE_SINK_TOKEN,
  useFactory: (sessions: SessionService): RunFailureSink =>
    (runId, failure) => sessions.failRunExternally(runId, failure),
  inject: [SessionService]
};

@Module({
  controllers: [HealthController, SessionController, StubController, FactSourceController],
  providers: [
    AgentEventsGateway,
    AgentRunner,
    ArtifactService,
    ContextService,
    DownstreamSessionManager,
    downstreamPersistenceProvider,
    downstreamRunFailureSinkProvider,
    EventStore,
    PrismaService,
    PrismaFactSourceRepository,
    { provide: FACT_SOURCE_REPOSITORY, useExisting: PrismaFactSourceRepository },
    RunStateService,
    SessionService,
    WorktreeService
  ]
})
export class AppModule {}
