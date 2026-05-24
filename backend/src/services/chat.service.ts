import { Inject, Injectable } from "@nestjs/common";
import { createId } from "./ids";
import { AgentRunner } from "./agent-runner.service";
import { AgentService } from "./agent.service";
import { WorktreeService } from "./worktree.service";
import { ConversationService } from "./conversation.service";
import type { AgentDto, AgentEvent, AgentRun } from "@agenthub/shared";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  conversationId?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: unknown[];
  tool_choice?: string;
  user?: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: unknown[];
    };
    finish_reason: string | null;
  }>;
}

@Injectable()
export class ChatService {
  constructor(
    @Inject(AgentRunner) private readonly runner: AgentRunner,
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(WorktreeService) private readonly worktrees: WorktreeService,
    @Inject(ConversationService) private readonly conversations: ConversationService,
  ) {}

  /**
   * Map model name to AgentHub agent ID.
   */
  resolveAgent(model: string): AgentDto {
    try {
      return this.agents.get(model);
    } catch {
      // Fall back to "claude" agent, then first available agent
      try {
        return this.agents.get("claude");
      } catch {
        const first = this.agents.list().items[0];
        if (first) return first;
        throw Object.assign(new Error(`Agent ${model} not found`), { statusCode: 404 });
      }
    }
  }

  /**
   * Convert OpenAI messages array to a single prompt string for Claude Code.
   */
  buildPrompt(messages: OpenAIChatMessage[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
      switch (msg.role) {
        case "system":
          parts.push(msg.content);
          break;
        case "user":
          parts.push(`User: ${msg.content}`);
          break;
        case "assistant":
          parts.push(`Assistant: ${msg.content}`);
          break;
        case "tool":
          parts.push(`Tool result (${msg.tool_call_id}): ${msg.content}`);
          break;
      }
    }
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const task = lastUserMsg?.content ?? parts.join("\n");
    return parts.join("\n\n") + "\n\nTask: " + task;
  }

  /**
   * Execute a chat completion with SSE streaming callbacks.
   */
  async streamChat(
    request: ChatCompletionRequest,
    onChunk: (chunk: ChatCompletionChunk) => void,
    onDone: (finalContent: string) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    const agent = this.resolveAgent(request.model);
    const prompt = this.buildPrompt(request.messages);
    const runId = createId("chatcmpl");
    // Reuse existing conversation or create new one
    const conversationId = request.conversationId ?? createId("conv");
    const now = new Date().toISOString();
    const created = Math.floor(Date.now() / 1000);

    let fullContent = "";

    // If using an existing conversation, save the user message first
    if (request.conversationId) {
      try {
        this.conversations.getOrCreate(request.conversationId, {
          title: request.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content.slice(0, 40))
            .join(" | ") || "Chat",
          agentId: agent.id,
        });
        this.conversations.createMessage(request.conversationId, {
          content: request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"),
        });
      } catch {
        // ignore save errors
      }
    }

    const run: AgentRun = {
      id: runId,
      agentId: agent.id,
      conversationId,
      status: "running",
      runtime: {
        agentId: agent.id,
        displayName: agent.name,
        provider: agent.provider,
        role: agent.role,
        worktreePath: "",
        branchName: "",
        status: "running",
      },
      prompt,
      createdAt: now,
      startedAt: now,
    };

    const worktree = await this.worktrees.prepare(runId);

    await this.runner.run({
      run,
      agent,
      prompt,
      worktree,
      emit: (event) => {
        if (event.type === "text_delta") {
          const text = typeof event.payload === "string"
            ? event.payload
            : (event.payload as { text?: string })?.text ?? "";
          if (text) {
            fullContent += text;
            onChunk({
              id: runId,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                },
              ],
            });
          }
        } else if (event.type === "agent_thinking") {
          // Optionally emit as reasoning_content
        }
      },
    }).then((result) => {
      // Final chunk with finish_reason = "stop"
      onChunk({
        id: runId,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      });

      // Save assistant message to conversation
      try {
        if (request.conversationId) {
          // Reuse existing conversation
          this.conversations.addAssistantMessage(request.conversationId, fullContent || result.output);
        } else {
          // Create new conversation for stateless calls
          const conv = this.conversations.create({
            title: request.messages
              .filter((m) => m.role === "user")
              .map((m) => m.content.slice(0, 30))
              .join(" | "),
            agentId: agent.id,
          });
          this.conversations.createMessage(conv.id, {
            content: prompt,
          });
          this.conversations.addAssistantMessage(conv.id, fullContent || result.output);
        }
      } catch {
        // ignore conversation save errors
      }

      onDone(fullContent || result.output);
    }).catch((error) => {
      onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /**
   * Get model list in OpenAI format.
   */
  listModels(): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> } {
    const { items } = this.agents.list();
    const created = Math.floor(Date.now() / 1000);
    return {
      object: "list",
      data: items.map((agent) => ({
        id: agent.id,
        object: "model" as const,
        created,
        owned_by: "agenthub",
      })),
    };
  }

  /**
   * Get a single model.
   */
  getModel(id: string): { id: string; object: "model"; created: number; owned_by: string } {
    const agent = this.agents.get(id);
    return {
      id: agent.id,
      object: "model",
      created: Math.floor(new Date(agent.createdAt).getTime() / 1000),
      owned_by: "agenthub",
    };
  }
}
