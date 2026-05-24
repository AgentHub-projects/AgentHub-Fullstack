import { Controller, HttpStatus, Injectable, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { AcpMessage } from "@agenthub/shared";
import { Inject } from "@nestjs/common";
import { AgentEventsGateway } from "./agent-events.gateway";
import { createId } from "../services/ids";
import { Body } from "@nestjs/common";

interface AcpMessageRequest {
  role: string;
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
  agentId?: string;
  runId?: string;
  conversationId?: string;
}

@Injectable()
export class AcpService {
  constructor(
    @Inject(AgentEventsGateway) private readonly gateway: AgentEventsGateway,
  ) {}

  /**
   * Convert an ACP message to an internal AgentEvent and broadcast it.
   */
  handleAcpMessage(msg: AcpMessageRequest): { ok: boolean } {
    const agentId = msg.agentId ?? "acp-client";
    const runId = msg.runId ?? createId("acprun");
    const conversationId = msg.conversationId ?? "acp-default";

    // Map ACP role/content to appropriate AgentEvent type
    if (msg.role === "tool" && msg.toolCallId) {
      this.gateway.emitAgentEvent({
        eventId: createId("event"),
        type: "tool_result",
        runId,
        conversationId,
        agentId,
        payload: {
          id: msg.toolCallId,
          content: msg.content,
        },
        seq: 0,
        ts: Date.now(),
      });
    } else if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        this.gateway.emitAgentEvent({
          eventId: createId("event"),
          type: "tool_use",
          runId,
          conversationId,
          agentId,
          payload: {
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          },
          seq: 0,
          ts: Date.now(),
        });
      }
    } else if (msg.role === "assistant") {
      this.gateway.emitAgentEvent({
        eventId: createId("event"),
        type: "text_delta",
        runId,
        conversationId,
        agentId,
        payload: { text: msg.content },
        seq: 0,
        ts: Date.now(),
      });
    } else {
      // Generic event for other roles
      this.gateway.emitAgentEvent({
        eventId: createId("event"),
        type: "text_delta",
        runId,
        conversationId,
        agentId,
        payload: { text: msg.content },
        seq: 0,
        ts: Date.now(),
      });
    }

    return { ok: true };
  }
}

/**
 * ACP (Agent Communication Protocol) Controller.
 *
 * POST /api/acp/messages - Accept ACP-formatted messages and broadcast them
 *   internally as AgentEvents through the WebSocket gateway.
 *
 * GET /api/acp/stream - SSE endpoint that streams AgentEvents to ACP clients.
 *   Clients connect and receive events as SSE text/event-stream.
 */
@Controller("acp")
export class AcpController {
  private readonly sseClients = new Set<Response>();

  constructor(
    @Inject(AcpService) private readonly acpService: AcpService,
    @Inject(AgentEventsGateway) private readonly gateway: AgentEventsGateway,
  ) {}

  @Post("messages")
  async handleMessage(@Body() body: AcpMessageRequest) {
    return this.acpService.handleAcpMessage(body);
  }

  @Post("messages/batch")
  async handleBatch(@Body() body: { messages: AcpMessageRequest[] }) {
    const results = body.messages.map((msg) => this.acpService.handleAcpMessage(msg));
    return { ok: true, count: results.length };
  }

  @Post("run")
  async startRun(@Body() body: { prompt: string; agentId?: string; conversationId?: string }) {
    const runId = createId("acprun");
    const agentId = body.agentId ?? "acp-agent";
    const conversationId = body.conversationId ?? "acp-default";

    this.gateway.emitAgentEvent({
      eventId: createId("event"),
      type: "agent_started",
      runId,
      conversationId,
      agentId,
      payload: { prompt: body.prompt },
      seq: 0,
      ts: Date.now(),
    });

    return { ok: true, runId, agentId, conversationId };
  }

  @Post("run/:runId/complete")
  async completeRun(
    @Body() body: { output?: string; error?: string },
    @Req() req: Request,
  ) {
    const runId = (req as any).params.runId;
    const agentId = body.error ? "acp-agent" : "acp-agent";
    const conversationId = "acp-default";

    if (body.error) {
      this.gateway.emitAgentEvent({
        eventId: createId("event"),
        type: "agent_failed",
        runId,
        conversationId,
        agentId,
        payload: { error: body.error },
        seq: 0,
        ts: Date.now(),
      });
    } else {
      this.gateway.emitAgentEvent({
        eventId: createId("event"),
        type: "agent_completed",
        runId,
        conversationId,
        agentId,
        payload: { output: body.output },
        seq: 0,
        ts: Date.now(),
      });
    }

    return { ok: true };
  }
}
