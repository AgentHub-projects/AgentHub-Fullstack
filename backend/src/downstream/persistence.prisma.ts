import type { PrismaClient } from "@prisma/client";
import type {
  DownstreamPersistence,
  PersistedDownstreamEvent
} from "./persistence";
import type { DownstreamConnectionState, DownstreamSessionDto } from "./types";

/** A narrow slice of PrismaClient that we actually need. Declaring the
 * dependency this way keeps unit tests free of a live Prisma generator
 * step and lets us inject a stub easily. */
export interface PrismaClientLike {
  downstreamSession: {
    upsert(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
  };
  downstreamEventAck: {
    create(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
  };
  $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T>;
}

/** Recognised Prisma error code for unique constraint violations. */
const PRISMA_UNIQUE_VIOLATION = "P2002";

interface PrismaSessionRow {
  agentHubSessionId: string;
  downstreamSessionId: string;
  downstreamAgentId: string;
  state: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: PrismaSessionRow): DownstreamSessionDto {
  return {
    agentHubSessionId: row.agentHubSessionId,
    downstreamSessionId: row.downstreamSessionId,
    downstreamAgentId: row.downstreamAgentId,
    state: row.state as DownstreamConnectionState,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === PRISMA_UNIQUE_VIOLATION
  );
}

/**
 * Prisma-backed implementation of {@link DownstreamPersistence}. Backs the
 * `DownstreamSession` and `DownstreamEventAck` tables defined in
 * `schema.prisma` and registered in `AppModule` for production runs so
 * session bindings and event acks survive process restarts.
 */
export class PrismaDownstreamPersistence implements DownstreamPersistence {
  constructor(private readonly prisma: PrismaClientLike) {}

  async upsertSession(input: {
    agentHubSessionId: string;
    downstreamSessionId: string;
    downstreamAgentId: string;
    state: DownstreamConnectionState;
  }): Promise<DownstreamSessionDto> {
    const row = (await this.prisma.downstreamSession.upsert({
      where: { agentHubSessionId: input.agentHubSessionId },
      create: {
        agentHubSessionId: input.agentHubSessionId,
        downstreamSessionId: input.downstreamSessionId,
        downstreamAgentId: input.downstreamAgentId,
        state: input.state,
        lastError: null
      },
      update: {
        downstreamSessionId: input.downstreamSessionId,
        downstreamAgentId: input.downstreamAgentId,
        state: input.state,
        lastError: null
      }
    })) as PrismaSessionRow;
    return toDto(row);
  }

  async updateSessionState(
    agentHubSessionId: string,
    state: DownstreamConnectionState,
    lastError?: string
  ): Promise<void> {
    try {
      await this.prisma.downstreamSession.update({
        where: { agentHubSessionId },
        data: { state, lastError: lastError ?? null }
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        // Mirror the in-memory implementation: silently ignore state
        // updates for unknown sessions so callers don't have to special-
        // case race conditions with deleted rows.
        return;
      }
      throw err;
    }
  }

  async getSession(agentHubSessionId: string): Promise<DownstreamSessionDto | null> {
    const row = (await this.prisma.downstreamSession.findUnique({
      where: { agentHubSessionId }
    })) as PrismaSessionRow | null;
    return row ? toDto(row) : null;
  }

  async persistEventAndAck(event: PersistedDownstreamEvent): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const existing = await tx.downstreamEventAck.findUnique({
        where: { eventId: event.eventId }
      });
      if (existing) {
        return false;
      }
      try {
        await tx.downstreamEventAck.create({
          data: {
            eventId: event.eventId,
            agentHubSessionId: event.agentHubSessionId,
            downstreamSessionId: event.downstreamSessionId,
            runId: event.runId,
            seq: event.seq
          }
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Concurrent delivery acked the same event id between the
          // findUnique and the create. Treat it as the idempotent path.
          return false;
        }
        throw err;
      }
      return true;
    });
  }
}

const PRISMA_RECORD_NOT_FOUND = "P2025";

function isRecordNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === PRISMA_RECORD_NOT_FOUND
  );
}

/** Factory used by the AppModule provider so consumers don't import
 * `@prisma/client` directly. Accepting `PrismaClient` keeps us aligned
 * with the schema; tests can pass any `PrismaClientLike`. */
export function createPrismaDownstreamPersistence(
  prisma: PrismaClient
): PrismaDownstreamPersistence {
  return new PrismaDownstreamPersistence(prisma as unknown as PrismaClientLike);
}
