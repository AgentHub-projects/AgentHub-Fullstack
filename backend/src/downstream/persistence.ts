/**
 * DownstreamPersistence is the narrow port the SessionManager uses for
 * persistence. Tests inject an in-memory store; the prod wiring backs it
 * with Prisma. Keeping it as a port ensures unit tests don't need a live
 * database to validate ack-after-persist semantics.
 */

import type { DownstreamConnectionState, DownstreamSessionDto } from "./types";

export interface PersistedDownstreamEvent {
  agentHubSessionId: string;
  downstreamSessionId: string;
  agentId: string;
  runId: string;
  eventId: string;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface DownstreamPersistence {
  upsertSession(input: {
    agentHubSessionId: string;
    downstreamSessionId: string;
    downstreamAgentId: string;
    state: DownstreamConnectionState;
  }): Promise<DownstreamSessionDto>;

  updateSessionState(
    agentHubSessionId: string,
    state: DownstreamConnectionState,
    lastError?: string
  ): Promise<void>;

  getSession(agentHubSessionId: string): Promise<DownstreamSessionDto | null>;

  /**
   * Atomically persist a downstream event AND record its ack so we can be
   * idempotent against duplicate deliveries. Returns true if a new event
   * was persisted, false if the eventId was already acked (idempotent
   * no-op).
   */
  persistEventAndAck(event: PersistedDownstreamEvent): Promise<boolean>;
}

/**
 * Default in-memory persistence implementation. Used by tests and as a
 * safe fallback when no DATABASE_URL is configured.
 */
export class InMemoryDownstreamPersistence implements DownstreamPersistence {
  private readonly sessions = new Map<string, DownstreamSessionDto>();
  private readonly ackedEventIds = new Set<string>();
  public readonly events: PersistedDownstreamEvent[] = [];

  async upsertSession(input: {
    agentHubSessionId: string;
    downstreamSessionId: string;
    downstreamAgentId: string;
    state: DownstreamConnectionState;
  }): Promise<DownstreamSessionDto> {
    const now = new Date().toISOString();
    const existing = this.sessions.get(input.agentHubSessionId);
    const dto: DownstreamSessionDto = {
      agentHubSessionId: input.agentHubSessionId,
      downstreamSessionId: input.downstreamSessionId,
      downstreamAgentId: input.downstreamAgentId,
      state: input.state,
      lastError: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.sessions.set(input.agentHubSessionId, dto);
    return dto;
  }

  async updateSessionState(
    agentHubSessionId: string,
    state: DownstreamConnectionState,
    lastError?: string
  ): Promise<void> {
    const existing = this.sessions.get(agentHubSessionId);
    if (!existing) return;
    this.sessions.set(agentHubSessionId, {
      ...existing,
      state,
      lastError,
      updatedAt: new Date().toISOString()
    });
  }

  async getSession(agentHubSessionId: string): Promise<DownstreamSessionDto | null> {
    return this.sessions.get(agentHubSessionId) ?? null;
  }

  async persistEventAndAck(event: PersistedDownstreamEvent): Promise<boolean> {
    if (this.ackedEventIds.has(event.eventId)) {
      return false;
    }
    this.ackedEventIds.add(event.eventId);
    this.events.push(event);
    return true;
  }
}
