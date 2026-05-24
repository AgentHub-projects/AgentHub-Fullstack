import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type {
  AgentEvent,
  AgentRun,
  CancelRunResponse,
  RunSessionRequest,
  RunSessionResponse,
  SessionDto
} from "@agenthub/shared";
import { AgentEventsGateway } from "../realtime/agent-events.gateway";
import { AgentRunner } from "./agent-runner.service";
import { AgentService } from "./agent.service";
import { ConversationService } from "./conversation.service";
import { ApiHttpException } from "./errors";
import { createId } from "./ids";
import { WorktreeService } from "./worktree.service";

function buildActiveRunIds(activeSet: Set<string>): string[] {
  return [...activeSet];
}

function computeSessionStatus(runs: Map<string, AgentRun>, activeSet: Set<string>): SessionDto["status"] {
  if (activeSet.size > 0) return "running";
  // Check if any runs failed
  for (const run of runs.values()) {
    if (run.status === "failed") return "failed";
  }
  return "idle";
}

@Injectable()
export class SessionService {
  private current: SessionDto = {
    id: "session-current",
    title: "Current Session",
    status: "idle",
    runIds: [],
    activeRunIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  private readonly runs = new Map<string, AgentRun>();
  private activeRunIds = new Set<string>();
  private eventSeq = 0;

  constructor(
    @Inject(AgentRunner) private readonly runner: AgentRunner,
    @Inject(WorktreeService) private readonly worktrees: WorktreeService,
    @Inject(AgentEventsGateway) private readonly gateway: AgentEventsGateway,
    @Inject(ConversationService) private readonly conversations: ConversationService,
    @Inject(AgentService) private readonly agents: AgentService
  ) {}

  getCurrentSession(): SessionDto {
    return this.current;
  }

  async run(request: RunSessionRequest): Promise<RunSessionResponse> {
    const prompt = request.prompt?.trim();
    if (!prompt) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "PROMPT_REQUIRED",
        message: "prompt is required"
      });
    }

    const runId = createId("run");
    const conversationId = request.conversationId ?? this.current.id;
    const agentId = request.config?.name ?? "claude";
    const now = new Date().toISOString();

    // Add user message to conversation if it exists
    try {
      this.conversations.createMessage(conversationId, { content: prompt });
    } catch {
      // conversation may not exist — ignore
    }

    const run: AgentRun = {
      id: runId,
      agentId,
      conversationId,
      status: "running",
      runtime: {
        agentId,
        displayName: request.config?.name ?? "Claude",
        provider: request.config?.provider ?? "local-cli",
        role: request.config?.role ?? "coding-agent",
        worktreePath: "",
        branchName: "",
        status: "running"
      },
      prompt,
      createdAt: now,
      startedAt: now
    };

    this.runs.set(runId, run);
    this.activeRunIds.add(runId);
    this.current = {
      ...this.current,
      status: "running",
      agentId,
      prompt,
      runIds: [...this.current.runIds, runId],
      activeRunIds: buildActiveRunIds(this.activeRunIds),
      updatedAt: now
    };

    void this.executeRun(run, request).catch((error: unknown) => {
      this.failRun(run, error);
    });

    return { session: this.current, run };
  }

  cancel(runId: string): CancelRunResponse {
    const run = this.runs.get(runId);
    if (!run) {
      throw new ApiHttpException(HttpStatus.NOT_FOUND, {
        code: "RUN_NOT_FOUND",
        message: `Run ${runId} was not found.`
      });
    }
    if (run.status !== "running") {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "RUN_NOT_ACTIVE",
        message: `Run ${runId} is not active.`
      });
    }

    this.runner.cancel(runId);
    const finishedAt = new Date().toISOString();
    run.status = "cancelled";
    run.finishedAt = finishedAt;
    run.runtime.status = "cancelled";
    this.activeRunIds.delete(runId);
    this.current = {
      ...this.current,
      status: computeSessionStatus(this.runs, this.activeRunIds),
      activeRunIds: buildActiveRunIds(this.activeRunIds),
      updatedAt: finishedAt
    };
    this.emit({
      type: "agent_cancelled",
      runId: run.id,
      conversationId: run.conversationId,
      agentId: run.agentId,
      payload: { runId }
    });

    return { session: this.current, run };
  }

  cancelCurrent(): CancelRunResponse {
    if (this.activeRunIds.size === 0) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "NO_ACTIVE_RUN",
        message: "There is no active run in this P0 session."
      });
    }
    // Cancel the most recently added active run
    const lastRunId = [...this.activeRunIds].at(-1)!;
    return this.cancel(lastRunId);
  }

  private async executeRun(run: AgentRun, request: RunSessionRequest): Promise<void> {
    this.emit({
      type: "agent_started",
      runId: run.id,
      conversationId: run.conversationId,
      agentId: run.agentId,
      payload: { prompt: run.prompt }
    });

    const worktree = await this.worktrees.prepare(run.id, request.testRepositoryPath);
    run.runtime.worktreePath = worktree.worktreePath;
    run.runtime.branchName = worktree.branchName;

    const agent = this.agents.get(run.agentId);
    const result = await this.runner.run({
      run,
      agent,
      prompt: run.prompt,
      worktree,
      emit: (event) => this.emit(event)
    });

    const testSync = await this.worktrees.complete(worktree, result.summary);
    const finishedAt = new Date().toISOString();
    if (testSync.status === "failed") {
      const message = testSync.error?.message ?? "Test repository sync failed.";
      run.status = "failed";
      run.output = { text: result.output, testSync };
      run.error = {
        code: testSync.error?.code ?? "TEST_SYNC_FAILED",
        message
      };
      run.finishedAt = finishedAt;
      run.runtime.status = "failed";
      this.activeRunIds.delete(run.id);
      this.current = {
        ...this.current,
        status: computeSessionStatus(this.runs, this.activeRunIds),
        output: result.output,
        error: message,
        testSync,
        activeRunIds: buildActiveRunIds(this.activeRunIds),
        updatedAt: finishedAt
      };
      this.emit({
        type: "agent_failed",
        runId: run.id,
        conversationId: run.conversationId,
        agentId: run.agentId,
        payload: run.error
      });
      this.emit({
        type: "done",
        runId: run.id,
        conversationId: run.conversationId,
        agentId: run.agentId,
        payload: { status: "failed" }
      });
      return;
    }

    run.status = "succeeded";
    run.output = { text: result.output, testSync };
    run.finishedAt = finishedAt;
    run.runtime.status = "succeeded";
    this.activeRunIds.delete(run.id);
    this.current = {
      ...this.current,
      status: computeSessionStatus(this.runs, this.activeRunIds),
      output: result.output,
      testSync,
      activeRunIds: buildActiveRunIds(this.activeRunIds),
      updatedAt: finishedAt
    };

    // Add assistant message
    try {
      this.conversations.addAssistantMessage(run.conversationId, result.output);
    } catch {
      // ignore
    }

    this.emit({
      type: "agent_completed",
      runId: run.id,
      conversationId: run.conversationId,
      agentId: run.agentId,
      payload: { output: result.output, testSync }
    });
    this.emit({
      type: "done",
      runId: run.id,
      conversationId: run.conversationId,
      agentId: run.agentId,
      payload: { status: "succeeded" }
    });
  }

  private failRun(run: AgentRun, error: unknown): void {
    if (run.status === "cancelled") {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    run.status = "failed";
    run.error = { code: "AGENT_RUN_FAILED", message };
    run.finishedAt = finishedAt;
    run.runtime.status = "failed";
    this.activeRunIds.delete(run.id);
    this.current = {
      ...this.current,
      status: computeSessionStatus(this.runs, this.activeRunIds),
      error: message,
      activeRunIds: buildActiveRunIds(this.activeRunIds),
      updatedAt: finishedAt
    };
    this.emit({
      type: "agent_failed",
      runId: run.id,
      conversationId: run.conversationId,
      agentId: run.agentId,
      payload: run.error
    });
  }

  private emit(event: Omit<AgentEvent, "eventId" | "seq" | "ts">): void {
    this.eventSeq += 1;
    this.gateway.emitAgentEvent({
      ...event,
      eventId: createId("event"),
      seq: this.eventSeq,
      ts: Date.now()
    });
  }
}
