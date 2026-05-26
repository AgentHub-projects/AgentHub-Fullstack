import { createServer } from "node:http";
import { Server } from "socket.io";

type RpcEnvelope = {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
};

const port = Number(process.env.MOCK_ORCHESTRATOR_PORT ?? 4010);
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  socket.on("acp:message", (message: RpcEnvelope) => {
    if (message.method === "initialize") {
      socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2026-05-agenthub-v1",
          serverInfo: { name: "mock-orchestrator", version: "0.1.0" },
          capabilities: { stream: true, artifacts: true, fileChangeSnapshot: true },
        },
      });
    }

    if (message.method === "session/load" || message.method === "session/new") {
      socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: message.id,
        result: { downstreamSessionId: `mock-${message.params?.agenthubSessionId ?? "session"}` },
      });
    }

    if (message.method === "session/prompt") {
      const params = message.params ?? {};
      const runId = String(params.runId);
      const mentioned = Array.isArray(params.mentionedAgentIds) ? params.mentionedAgentIds.map(String) : [];
      const speakers = mentioned.length ? mentioned : [String(params.agentId ?? "mock-orchestrator")];
      socket.emit("acp:message", { jsonrpc: "2.0", id: message.id, result: { accepted: true, runId } });
      void streamMockRun(socket, runId, speakers);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`mock orchestrator listening on http://localhost:${port}`);
});

async function streamMockRun(socket: Parameters<Parameters<typeof io.on>[1]>[0], runId: string, speakers: string[]) {
  let seq = 1;
  for (const speaker of speakers) {
    await sleep(220);
    socket.emit("session/event", {
      runId,
      seq: seq++,
      type: "message.delta",
      speaker,
      payload: {
        speaker,
        text: `${speaker} 正在处理当前任务，并通过 session/event 上报流式输出。`,
      },
    });
  }

  await sleep(220);
  socket.emit("session/event", {
    runId,
    seq: seq++,
    type: "file.change",
    speaker: speakers[0],
    payload: {
      speaker: speakers[0],
      path: "src/example.ts",
      changeType: "modified",
      language: "ts",
      before: { content: "export const status = 'old';", truncated: false },
      after: { content: "export const status = 'agenthub-ready';", truncated: false },
      patch: "@@ -1 +1 @@\n-export const status = 'old';\n+export const status = 'agenthub-ready';\n",
    },
  });

  await sleep(220);
  socket.emit("session/event", {
    runId,
    seq: seq++,
    type: "artifact.upsert",
    speaker: speakers[0],
    payload: {
      speaker: speakers[0],
      artifactKey: "mock-summary",
      kind: "markdown",
      title: "Mock 执行摘要",
      mimeType: "text/markdown; charset=utf-8",
      content: "# Mock 执行摘要\n\n- message.delta 已发送\n- file.change 已发送\n- artifact.upsert 已发送",
      final: true,
    },
  });

  await sleep(220);
  socket.emit("session/event", {
    runId,
    seq: seq++,
    type: "message.completed",
    speaker: speakers[0],
    payload: {
      speaker: speakers[0],
      text: "Mock run completed.",
    },
  });

  await sleep(120);
  socket.emit("session/event", {
    runId,
    seq,
    type: "run.completed",
    speaker: speakers[0],
    payload: { status: "completed" },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
