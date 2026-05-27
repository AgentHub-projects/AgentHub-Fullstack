import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { AgentEvent, AgentEventType } from "@agenthub/shared";
import { AgentEventsGateway } from "../realtime/agent-events.gateway";
import { createId } from "../services/ids";
import { NorthAdapter } from "./north-adapter";
import {
  DownstreamError,
  DownstreamErrorCode,
  NorthMethod,
  type DownstreamConnectionState,
  type DownstreamMention,
  type DownstreamPinnedContextItem,
  type DownstreamSessionDto,
  type InitializeResult,
  type SessionEventParams,
  type SessionEventResult,
  type SessionLoadResult,
  type SessionNewResult,
  type SessionPromptResult
} from "./types";
import {
  InMemoryDownstreamPersistence,
  type DownstreamPersistence
} from "./persistence";

export interface RunFailure {
  code: string;
  message: string;
}

/** Callback invoked by the manager when a downstream connection error
 * should mark the active run as failed. The session/run domain layer (the
 * existing SessionService) decides what that means. */
export type RunFailureSink = (runId: string, failure: RunFailure) => void;

export const DOWNSTREAM_PERSISTENCE_TOKEN = "DOWNSTREAM_PERSISTENCE";
export const DOWNSTREAM_RUN_FAILURE_SINK_TOKEN = "DOWNSTREAM_RUN_FAILURE_SINK";

@Injectable()
export class DownstreamSessionManager {
  private readonly log = new Logger(DownstreamSessionManager.name);
  private adapter?: NorthAdapter;
  /** Maps the AgentHub session id -> active run id, so server-initiated
   * `session/event` requests can route delta/completion events to the
   * matching local run. */
  private readonly runIdBySession = new Map<string, string>();
  private readonly persistence: DownstreamPersistence;
  private readonly runFailureSink?: RunFailureSink;

  constructor(
    private readonly gateway: AgentEventsGateway,
    @Optional() @Inject(DOWNSTREAM_PERSISTENCE_TOKEN) persistenceParam?: DownstreamPersistence,
    @Optional() @Inject(DOWNSTREAM_RUN_FAILURE_SINK_TOKEN) runFailureSinkParam?: RunFailureSink
  ) {
    if (!persistenceParam) {
      // Highly visible warning: the in-memory fallback loses every session
      // binding on restart, so production wiring MUST register a real
      // DOWNSTREAM_PERSISTENCE provider in AppModule. We log instead of
      // throwing so unit tests that construct the manager directly still
      // work without DI.
      this.log.warn(
        "DownstreamSessionManager constructed without a persistence provider; falling back to in-memory store. Session bindings will not survive a restart."
      );
    }
    this.persistence = persistenceParam ?? new InMemoryDownstreamPersistence();
    this.runFailureSink = runFailureSinkParam;
  }

  /** Bind a NorthAdapter to this manager. Tests may rebind freely; prod
   * wiring binds once during bootstrap. */
  attachAdapter(adapter: NorthAdapter): void {
    this.adapter = adapter;
    adapter.setServerRequestHandler(async (method, params) => {
      if (method === NorthMethod.SessionEvent) {
        return await this.handleSessionEvent(params as SessionEventParams);
      }
      throw new DownstreamError(
        DownstreamErrorCode.Protocol,
        `unsupported server method: ${method}`
      );
    });
  }

  /** Test helper: which run id is currently bound to a session, if any. */
  getRunIdForSession(agentHubSessionId: string): string | undefined {
    return this.runIdBySession.get(agentHubSessionId);
  }

  setActiveRun(agentHubSessionId: string, runId: string | undefined): void {
    if (runId) this.runIdBySession.set(agentHubSessionId, runId);
    else this.runIdBySession.delete(agentHubSessionId);
  }

  /** JSON-RPC initialize handshake. */
  async initialize(client = { name: "agenthub", version: "0.1.0" }): Promise<InitializeResult> {
    const adapter = this.requireAdapter();
    return await adapter.request<InitializeResult>(NorthMethod.Initialize, { client });
  }

  /**
   * Get-or-create a downstream session for the given AgentHub session id.
   * If a binding already exists locally, the manager calls `session/load`
   * to attach to it on the orchestrator side; otherwise it calls
   * `session/new` and persists the resulting binding only AFTER the
   * orchestrator has assigned a real downstream id (no sentinel rows).
   */
  async ensureSession(input: {
    agentHubSessionId: string;
    downstreamAgentId: string;
    title?: string;
  }): Promise<DownstreamSessionDto> {
    const adapter = this.requireAdapter();
    const existing = await this.persistence.getSession(input.agentHubSessionId);
    if (existing) {
      try {
        this.log.log(
          `ensureSession[${input.agentHubSessionId}]: connecting via session/load (downstreamSessionId=${existing.downstreamSessionId})`
        );
        await this.markState(input.agentHubSessionId, "connecting");
        await adapter.request<SessionLoadResult>(NorthMethod.SessionLoad, {
          downstreamSessionId: existing.downstreamSessionId
        });
        const ready = await this.markState(input.agentHubSessionId, "ready");
        this.log.log(`ensureSession[${input.agentHubSessionId}]: ready (reused)`);
        return ready;
      } catch (err) {
        const message = asMessage(err);
        this.log.error(`ensureSession[${input.agentHubSessionId}]: failed during session/load: ${message}`);
        await this.markState(input.agentHubSessionId, "failed", message);
        throw err;
      }
    }

    // First-time create. We do NOT pre-write a sentinel row with an empty
    // downstreamSessionId — the @@unique([downstreamAgentId,downstreamSessionId])
    // constraint would reject concurrent first-time calls for the same
    // downstreamAgentId. Instead, we wait for the orchestrator to assign
    // an id and persist the binding on the success path only.
    this.log.log(
      `ensureSession[${input.agentHubSessionId}]: connecting via session/new (downstreamAgentId=${input.downstreamAgentId})`
    );
    let result: SessionNewResult;
    try {
      result = await adapter.request<SessionNewResult>(NorthMethod.SessionNew, {
        agentHubSessionId: input.agentHubSessionId,
        agentId: input.downstreamAgentId,
        title: input.title
      });
    } catch (err) {
      const message = asMessage(err);
      this.log.error(`ensureSession[${input.agentHubSessionId}]: session/new failed: ${message}`);
      throw err;
    }

    try {
      const persisted = await this.persistence.upsertSession({
        agentHubSessionId: input.agentHubSessionId,
        downstreamSessionId: result.downstreamSessionId,
        downstreamAgentId: input.downstreamAgentId,
        state: "ready"
      });
      this.log.log(
        `ensureSession[${input.agentHubSessionId}]: ready (new, downstreamSessionId=${result.downstreamSessionId})`
      );
      return persisted;
    } catch (err) {
      const message = asMessage(err);
      this.log.error(`ensureSession[${input.agentHubSessionId}]: persist failed: ${message}`);
      // Best-effort: try to record the failed state if the row already
      // exists from a prior run; ignore secondary errors.
      try {
        await this.persistence.updateSessionState(input.agentHubSessionId, "failed", message);
      } catch {
        /* ignore secondary persistence error */
      }
      throw err;
    }
  }

  /** Send a prompt for the given run on a previously-ensured session. */
  async sendPrompt(input: {
    agentHubSessionId: string;
    runId: string;
    prompt: string;
    mentions?: DownstreamMention[];
    context?: DownstreamPinnedContextItem[];
  }): Promise<void> {
    const adapter = this.requireAdapter();
    const session = await this.persistence.getSession(input.agentHubSessionId);
    if (!session) {
      throw new DownstreamError(
        DownstreamErrorCode.Protocol,
        `no downstream session bound for ${input.agentHubSessionId}`
      );
    }
    this.runIdBySession.set(input.agentHubSessionId, input.runId);
    try {
      await adapter.request<SessionPromptResult>(NorthMethod.SessionPrompt, {
        downstreamSessionId: session.downstreamSessionId,
        runId: input.runId,
        prompt: input.prompt,
        mentions: input.mentions,
        context: input.context
      });
    } catch (err) {
      // A failed `session/prompt` cannot leave the local run dangling;
      // surface it as a run failure so SessionService can fail the run.
      this.failRunFor(input.runId, err);
      throw err;
    }
  }

  /** Cancel the currently bound run on the downstream side. */
  async cancel(input: { agentHubSessionId: string; runId: string }): Promise<void> {
    const adapter = this.requireAdapter();
    const session = await this.persistence.getSession(input.agentHubSessionId);
    if (!session) return;
    try {
      await adapter.request(NorthMethod.SessionCancel, {
        downstreamSessionId: session.downstreamSessionId,
        runId: input.runId
      });
    } finally {
      this.setActiveRun(input.agentHubSessionId, undefined);
    }
  }

  /**
   * Server-initiated `session/event`. We MUST persist the event before
   * acking. If persistence fails we throw; the adapter then writes back
   * a JSON-RPC error response and the orchestrator can retry. Acking
   * before persistence would silently drop events on crash, so it's never
   * fire-and-forget here.
   */
  private async handleSessionEvent(params: SessionEventParams): Promise<SessionEventResult> {
    const isNew = await this.persistence.persistEventAndAck({
      agentHubSessionId: params.agentHubSessionId,
      downstreamSessionId: params.downstreamSessionId,
      agentId: params.agentId,
      runId: params.runId,
      eventId: params.eventId,
      seq: params.seq,
      ts: params.ts,
      type: String(params.type),
      payload: params.payload
    });

    if (isNew) {
      const event: AgentEvent = {
        eventId: params.eventId,
        type: params.type as AgentEventType,
        runId: params.runId,
        conversationId: params.agentHubSessionId,
        agentId: params.agentId,
        payload: params.payload,
        seq: params.seq,
        ts: params.ts
      };
      this.gateway.emitAgentEvent(event);
    }

    return { acked: true, eventId: params.eventId };
  }

  /** Mark a downstream connection failure on every session bound to this
   * adapter, and fail the active runs. Called by the bootstrap when the
   * transport closes unexpectedly. */
  async handleConnectionLost(error: Error): Promise<void> {
    const message = asMessage(error);
    this.log.error(
      `handleConnectionLost: ${message} (active runs=${this.runIdBySession.size})`
    );
    for (const [sessionId, runId] of this.runIdBySession.entries()) {
      await this.markState(sessionId, "failed", message);
      this.runFailureSink?.(runId, {
        code: DownstreamErrorCode.TransportClosed,
        message: `downstream connection lost: ${message}`
      });
    }
    this.runIdBySession.clear();
  }

  // --- helpers ---

  private requireAdapter(): NorthAdapter {
    if (!this.adapter) {
      throw new DownstreamError(
        DownstreamErrorCode.Protocol,
        "DownstreamSessionManager has no adapter attached"
      );
    }
    return this.adapter;
  }

  private async markState(
    agentHubSessionId: string,
    state: DownstreamConnectionState,
    lastError?: string
  ): Promise<DownstreamSessionDto> {
    await this.persistence.updateSessionState(agentHubSessionId, state, lastError);
    const next = await this.persistence.getSession(agentHubSessionId);
    if (!next) {
      // Should never happen: state transitions only after upsert. Surface
      // it loudly because silent inconsistencies here corrupt later runs.
      throw new DownstreamError(
        DownstreamErrorCode.Persistence,
        `failed to update state for missing session ${agentHubSessionId}`
      );
    }
    return next;
  }

  private failRunFor(runId: string, err: unknown): void {
    const message = asMessage(err);
    this.runFailureSink?.(runId, {
      code: err instanceof DownstreamError ? err.code : DownstreamErrorCode.Remote,
      message
    });
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Generate ids for downstream-originated events when caller doesn't supply
// one. Exposed for tests that need to forge events.
export function generateDownstreamEventId(): string {
  return createId("dwn-event");
}
