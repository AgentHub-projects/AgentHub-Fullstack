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
import { ApiHttpException } from "./errors";
import { createId } from "./ids";
import { WorktreeService } from "./worktree.service";

type CompletedRunStatus = "succeeded" | "failed" | "cancelled";

@Injectable()
export class SessionService {
  private current: SessionDto = {
    id: "session-current",
    title: "Current Session",
    status: "idle",
    runIds: [],
    agentIds: [],
    mode: "direct",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  private readonly runs = new Map<string, AgentRun>();
  private activeRunId?: string;
  private eventSeq = 0;

  constructor(
    @Inject(AgentRunner) private readonly runner: AgentRunner,
    @Inject(WorktreeService) private readonly worktrees: WorktreeService,
    @Inject(AgentEventsGateway) private readonly gateway: AgentEventsGateway
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
    if (this.activeRunId) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "ACTIVE_RUN_EXISTS",
        message: "A run is already active in this P0 session."
      });
    }

    const mode = request.mode ?? "direct";
    const resolvedAgentIds = this.resolveAgentIds(request);
    const agentIds = mode === "direct" ? [resolvedAgentIds[0]] : resolvedAgentIds;

    if (mode === "group" && agentIds.length < 2) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "GROUP_REQUIRES_MULTIPLE_AGENTS",
        message: "Group mode requires at least two agent IDs."
      });
    }

    const conversationId = this.current.id;
    const now = new Date().toISOString();
    const runs = agentIds.map((agentId, index) =>
      this.createRun({
        agentId,
        conversationId,
        now,
        prompt,
        request,
        status: index === 0 ? "running" : "queued"
      })
    );
    const firstRun = runs[0];

    for (const run of runs) {
      this.runs.set(run.id, run);
    }
    this.activeRunId = firstRun.id;
    this.current = {
      ...this.current,
      status: "running",
      agentId: firstRun.agentId,
      agentIds,
      mode,
      prompt,
      runIds: [...this.current.runIds, ...runs.map((run) => run.id)],
      updatedAt: now
    };

    if (mode === "group") {
      void this.executeGroupRuns(runs, request);
    } else {
      void this.executeRun(firstRun, request, { finalizeOnSuccess: true }).catch((error: unknown) => {
        this.failRun(firstRun, error);
      });
    }

    return { session: this.current, run: firstRun };
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
    this.cancelQueuedRuns(finishedAt);
    this.activeRunId = undefined;
    this.current = {
      ...this.current,
      status: "idle",
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
    if (!this.activeRunId) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "NO_ACTIVE_RUN",
        message: "There is no active run in this P0 session."
      });
    }
    return this.cancel(this.activeRunId);
  }

  /**
   * Public hook used by the downstream layer (DownstreamSessionManager's
   * RunFailureSink) to mark a run failed when the orchestrator connection
   * dies or rejects a prompt. The hook is a no-op for already-finished
   * runs so a late connection-lost callback can't resurrect a run that
   * already completed via the normal in-process path.
   */
  failRunExternally(runId: string, failure: { code: string; message: string }): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.status !== "running") return;
    this.failRun(run, new Error(failure.message), failure.code);
  }

  private resolveAgentIds(request: RunSessionRequest): string[] {
    const explicitAgentIds = request.agentIds?.map((agentId) => agentId.trim()).filter(Boolean);
    if (explicitAgentIds && explicitAgentIds.length > 0) {
      return explicitAgentIds;
    }

    const configuredAgentId = request.config?.name.trim();
    return [configuredAgentId || "claude"];
  }

  private createRun(args: {
    agentId: string;
    conversationId: string;
    now: string;
    prompt: string;
    request: RunSessionRequest;
    status: "running" | "queued";
  }): AgentRun {
    const config = args.request.config?.name === args.agentId ? args.request.config : undefined;

    return {
      id: createId("run"),
      agentId: args.agentId,
      conversationId: args.conversationId,
      status: args.status,
      runtime: {
        agentId: args.agentId,
        displayName: config?.name ?? args.agentId,
        provider: config?.provider ?? "local-cli",
        role: config?.role ?? "coding-agent",
        worktreePath: "",
        branchName: "",
        status: args.status === "running" ? "running" : "idle"
      },
      prompt: args.prompt,
      createdAt: args.now,
      ...(args.status === "running" ? { startedAt: args.now } : {})
    };
  }

  private startQueuedRun(run: AgentRun): void {
    const now = new Date().toISOString();
    run.status = "running";
    run.startedAt = now;
    run.runtime.status = "running";
    this.activeRunId = run.id;
    this.current = {
      ...this.current,
      status: "running",
      agentId: run.agentId,
      updatedAt: now
    };
  }

  private cancelQueuedRuns(finishedAt: string): void {
    for (const runId of this.current.runIds) {
      const run = this.runs.get(runId);
      if (run?.status !== "queued") {
        continue;
      }
      run.status = "cancelled";
      run.finishedAt = finishedAt;
      run.runtime.status = "cancelled";
    }
  }

  private async executeGroupRuns(runs: AgentRun[], request: RunSessionRequest): Promise<void> {
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      if (index > 0) {
        this.startQueuedRun(run);
      }

      const status = await this.executeRun(run, request, {
        finalizeOnSuccess: index === runs.length - 1
      }).catch((error: unknown) => {
        this.failRun(run, error);
        return "failed" as const;
      });

      if (status !== "succeeded") {
        return;
      }
    }
  }

  private async executeRun(
    run: AgentRun,
    request: RunSessionRequest,
    options: { finalizeOnSuccess: boolean }
  ): Promise<CompletedRunStatus> {
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

    if (this.isRunCancelled(run)) {
      return "cancelled";
    }

    const result = await this.runner.run({
      run,
      prompt: run.prompt,
      worktree,
      emit: (event) => this.emit(event)
    });

    if (this.isRunCancelled(run)) {
      return "cancelled";
    }

    const testSync = await this.worktrees.complete(worktree, result.summary);
    if (this.isRunCancelled(run)) {
      return "cancelled";
    }

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
      this.cancelQueuedRuns(finishedAt);
      this.activeRunId = undefined;
      this.current = {
        ...this.current,
        status: "failed",
        output: result.output,
        error: message,
        testSync,
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
      return "failed";
    }

    run.status = "succeeded";
    run.output = { text: result.output, testSync };
    run.finishedAt = finishedAt;
    run.runtime.status = "succeeded";
    this.activeRunId = undefined;
    this.current = {
      ...this.current,
      status: options.finalizeOnSuccess ? "succeeded" : this.current.status,
      output: result.output,
      testSync,
      updatedAt: finishedAt
    };
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
    return "succeeded";
  }

  private failRun(run: AgentRun, error: unknown, code = "AGENT_RUN_FAILED"): void {
    if (run.status === "cancelled") {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    run.status = "failed";
    run.error = { code, message };
    run.finishedAt = finishedAt;
    run.runtime.status = "failed";
    this.cancelQueuedRuns(finishedAt);
    this.activeRunId = undefined;
    this.current = {
      ...this.current,
      status: "failed",
      error: message,
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

  private isRunCancelled(run: AgentRun): boolean {
    return run.status === "cancelled";
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
