import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownstreamOrchestratorService } from "../src/modules/hub/services/downstream-orchestrator.service";

const socketIoMock = vi.hoisted(() => ({
  io: vi.fn(),
}));

const redisMock = vi.hoisted(() => ({
  instances: [] as Array<{ on: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>,
}));

vi.mock("socket.io-client", () => ({
  io: socketIoMock.io,
}));

vi.mock("ioredis", () => {
  class RedisMock {
    on = vi.fn();
    set = vi.fn().mockResolvedValue("OK");
    exists = vi.fn().mockResolvedValue(1);
    disconnect = vi.fn();

    constructor() {
      redisMock.instances.push(this);
    }
  }

  return { default: RedisMock };
});

type AcpRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
};

type MockSocket = ReturnType<typeof createSocket>;

const originalDownstreamUrl = process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL;
const services: DownstreamOrchestratorService[] = [];

beforeEach(() => {
  process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL = "ws://downstream.test";
  socketIoMock.io.mockReset();
  redisMock.instances.length = 0;
});

afterEach(() => {
  for (const service of services.splice(0)) service.onModuleDestroy();
  if (originalDownstreamUrl === undefined) {
    delete process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL;
  } else {
    process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL = originalDownstreamUrl;
  }
});

describe("DownstreamOrchestratorService subscription session handshake", () => {
  it("creates a downstream session on subscribe when no downstreamSessionId exists", async () => {
    const socket = createSocket((request) => request.method === "session/new" ? { sessionId: "downstream-1" } : {});
    socketIoMock.io.mockReturnValueOnce(socket as any);
    const { service, prisma } = createService(null);

    await service.prepareSessionConnection("session-1");

    expect(methods(socket)).toEqual(["initialize", "session/new"]);
    expect(requests(socket)[1].params).toEqual({ mcpServers: [] });
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { downstreamSessionId: "downstream-1" },
    });
  });

  it("loads an existing downstream session on subscribe", async () => {
    const socket = createSocket(() => ({}));
    socketIoMock.io.mockReturnValueOnce(socket as any);
    const { service, prisma } = createService("downstream-existing");

    await service.prepareSessionConnection("session-1");

    expect(methods(socket)).toEqual(["initialize", "session/load"]);
    expect(requests(socket)[1].params).toEqual({
      sessionId: "downstream-existing",
      mcpServers: [],
    });
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it("does not repeat new/load when the connection is already ready", async () => {
    const socket = createSocket((request) => request.method === "session/new" ? { sessionId: "downstream-1" } : {});
    socketIoMock.io.mockReturnValueOnce(socket as any);
    const { service } = createService(null);

    await service.prepareSessionConnection("session-1");
    await service.prepareSessionConnection("session-1");

    expect(socketIoMock.io).toHaveBeenCalledTimes(1);
    expect(methods(socket)).toEqual(["initialize", "session/new"]);
  });

  it("does not repeat new/load while the connection is still preparing", async () => {
    const socket = createSocket();
    socketIoMock.io.mockReturnValueOnce(socket as any);
    const { service } = createService(null);

    const first = service.prepareSessionConnection("session-1");
    await waitUntil(() => methods(socket).length === 1);
    const second = service.prepareSessionConnection("session-1");

    expect(socketIoMock.io).toHaveBeenCalledTimes(1);
    socket.respond(0, {});
    await waitUntil(() => methods(socket).length === 2);
    socket.respond(1, { sessionId: "downstream-1" });
    await Promise.all([first, second]);

    expect(methods(socket)).toEqual(["initialize", "session/new"]);
  });

  it("loads the saved downstream session after an unexpected disconnect with subscribers", async () => {
    const sockets: MockSocket[] = [];
    socketIoMock.io.mockImplementation(() => {
      const socket = createSocket((request) => request.method === "session/new" ? { sessionId: "downstream-1" } : {});
      sockets.push(socket);
      return socket as any;
    });
    const { service } = createService(null);

    await service.prepareSessionConnection("session-1");
    sockets[0].disconnect();
    await waitUntil(() => sockets.length === 2 && methods(sockets[1]).length === 2);

    expect(methods(sockets[1])).toEqual(["initialize", "session/load"]);
    expect(requests(sockets[1])[1].params).toEqual({
      sessionId: "downstream-1",
      mcpServers: [],
    });
  });
});

function createService(initialDownstreamSessionId: string | null) {
  let downstreamSessionId = initialDownstreamSessionId;
  const prisma = {
    session: {
      findUnique: vi.fn().mockImplementation(async () => ({ downstreamSessionId })),
      update: vi.fn().mockImplementation(async ({ data }) => {
        downstreamSessionId = data.downstreamSessionId;
        return { id: "session-1", downstreamSessionId };
      }),
    },
  };
  const gateway = {
    onSessionSubscribed: vi.fn().mockReturnValue(vi.fn()),
    hasSessionSubscribers: vi.fn().mockReturnValue(true),
    emitSession: vi.fn(),
    emitContext: vi.fn(),
  };
  const sandboxRegistry = {
    saveFromSessionResult: vi.fn().mockResolvedValue(undefined),
  };
  const service = new DownstreamOrchestratorService(
    prisma as any,
    { append: vi.fn() } as any,
    gateway as any,
    {} as any,
    sandboxRegistry as any,
  );
  services.push(service);
  return { service, prisma, gateway, sandboxRegistry };
}

function createSocket(responder?: (request: AcpRequest) => Record<string, unknown> | undefined) {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const sent: Array<{ event: string; payload: any }> = [];
  const socket = {
    connected: true,
    sent,
    on(event: string, handler: (...args: any[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
      return socket;
    },
    once(event: string, handler: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        socket.off(event, wrapped);
        handler(...args);
      };
      return socket.on(event, wrapped);
    },
    off(event: string, handler: (...args: any[]) => void) {
      handlers.get(event)?.delete(handler);
      return socket;
    },
    emit(event: string, payload: any) {
      sent.push({ event, payload });
      if (event === "acp:message" && payload?.method && payload?.id && responder) {
        const result = responder(payload as AcpRequest);
        if (result !== undefined) queueMicrotask(() => socket.fire("acp:message", { jsonrpc: "2.0", id: payload.id, result }));
      }
      return true;
    },
    disconnect() {
      if (!socket.connected) return;
      socket.connected = false;
      socket.fire("disconnect");
    },
    fire(event: string, ...args: any[]) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
    },
    respond(requestIndex: number, result: Record<string, unknown>) {
      const request = requests(socket)[requestIndex];
      socket.fire("acp:message", { jsonrpc: "2.0", id: request.id, result });
    },
  };
  return socket;
}

function requests(socket: MockSocket): AcpRequest[] {
  return socket.sent
    .filter((item) => item.event === "acp:message" && item.payload?.method)
    .map((item) => item.payload as AcpRequest);
}

function methods(socket: MockSocket) {
  return requests(socket).map((request) => request.method);
}

async function waitUntil(predicate: () => boolean) {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitUntil timeout");
}
