import { Module, Provider } from "@nestjs/common";
import { AgentRunner } from "../services/agent-runner.service";
import { AgentEventsGateway } from "../realtime/agent-events.gateway";
import { HealthController } from "../controllers/health.controller";
import { SessionController } from "../controllers/session.controller";
import { StubController } from "../controllers/stub.controller";
import { PrismaService } from "../services/prisma.service";
import { SessionService } from "../services/session.service";
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
  controllers: [HealthController, SessionController, StubController],
  providers: [
    AgentEventsGateway,
    AgentRunner,
    SessionService,
    WorktreeService,
    PrismaService,
    downstreamPersistenceProvider,
    downstreamRunFailureSinkProvider,
    DownstreamSessionManager
  ]
})
export class AppModule {}
