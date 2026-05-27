import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { AgentEvent, ArtifactChunkDto, ArtifactDto, RunStateDto } from "@agenthub/shared";
import { ArtifactService } from "../services/artifact.service";
import { ContextService, type ContextSearchResult } from "../services/context.service";
import { EventStore, type EventIngestResult } from "../services/event-store.service";
import { RunStateService } from "../services/run-state.service";

@Controller()
export class FactSourceController {
  constructor(
    @Inject(EventStore) private readonly events: EventStore,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(ContextService) private readonly context: ContextService,
    @Inject(RunStateService) private readonly runState: RunStateService
  ) {}

  @Post("agent-events/ingest")
  @HttpCode(200)
  ingestEvent(@Body() event: AgentEvent): Promise<EventIngestResult> {
    return this.events.ingest(event);
  }

  @Get("agent-runs/:runId/state")
  refreshRunState(@Param("runId") runId: string): Promise<RunStateDto> {
    return this.runState.refresh(runId);
  }

  @Post("artifacts/:artifactId/chunks")
  @HttpCode(200)
  putArtifactChunk(
    @Param("artifactId") artifactId: string,
    @Body()
    body: {
      runId: string;
      index: number;
      content: string;
      kind?: string;
      path?: string;
      sha256?: string;
    }
  ): Promise<ArtifactChunkDto> {
    return this.artifacts.putChunk({
      artifactId,
      runId: body.runId,
      index: body.index,
      content: body.content,
      kind: body.kind,
      path: body.path,
      sha256: body.sha256
    });
  }

  @Post("artifacts/:artifactId/complete")
  @HttpCode(200)
  completeArtifact(
    @Param("artifactId") artifactId: string,
    @Body() body: { runId: string; kind?: string; path?: string; sha256?: string }
  ): Promise<ArtifactDto> {
    return this.artifacts.complete({
      artifactId,
      runId: body.runId,
      kind: body.kind,
      path: body.path,
      sha256: body.sha256
    });
  }

  @Get("context/search")
  searchContext(
    @Query("conversationId") conversationId: string,
    @Query("runId") runId?: string,
    @Query("q") query?: string
  ): Promise<ContextSearchResult> {
    return this.context.search({ conversationId, runId, query });
  }
}
