import { Injectable } from "@nestjs/common";
import type {
  ConversationDto,
  CreateConversationRequest,
  CreateMessageRequest,
  MessageDto,
} from "@agenthub/shared";
import { createId } from "./ids";

@Injectable()
export class ConversationService {
  private readonly conversations = new Map<string, ConversationDto>();
  private readonly messages = new Map<string, MessageDto[]>();

  list(): { items: ConversationDto[] } {
    const items = [...this.conversations.values()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return { items };
  }

  get(id: string): ConversationDto {
    const conv = this.conversations.get(id);
    if (!conv) {
      throw Object.assign(new Error(`Conversation ${id} not found`), { statusCode: 404 });
    }
    return conv;
  }

  create(request: CreateConversationRequest): ConversationDto {
    const id = createId("conv");
    const now = new Date().toISOString();
    const conv: ConversationDto = {
      id,
      title: request.title ?? "New Conversation",
      agentId: request.agentId ?? "claude",
      type: request.type ?? "direct",
      teamId: request.teamId,
      status: "idle",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(id, conv);
    this.messages.set(id, []);
    return conv;
  }

  /**
   * Get an existing conversation or create a new one with the given ID.
   */
  getOrCreate(id: string, request: CreateConversationRequest): ConversationDto {
    const existing = this.conversations.get(id);
    if (existing) return existing;

    const now = new Date().toISOString();
    const conv: ConversationDto = {
      id,
      title: request.title ?? "New Conversation",
      agentId: request.agentId ?? "claude",
      type: request.type ?? "direct",
      teamId: request.teamId,
      status: "idle",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(id, conv);
    this.messages.set(id, []);
    return conv;
  }

  delete(id: string): { ok: boolean } {
    if (!this.conversations.has(id)) {
      throw Object.assign(new Error(`Conversation ${id} not found`), { statusCode: 404 });
    }
    this.conversations.delete(id);
    this.messages.delete(id);
    return { ok: true };
  }

  listMessages(conversationId: string): { conversationId: string; items: MessageDto[] } {
    if (!this.conversations.has(conversationId)) {
      throw Object.assign(new Error(`Conversation ${conversationId} not found`), { statusCode: 404 });
    }
    return {
      conversationId,
      items: this.messages.get(conversationId) ?? [],
    };
  }

  createMessage(conversationId: string, request: CreateMessageRequest): MessageDto {
    if (!this.conversations.has(conversationId)) {
      throw Object.assign(new Error(`Conversation ${conversationId} not found`), { statusCode: 404 });
    }

    const id = createId("msg");
    const now = new Date().toISOString();
    const message: MessageDto = {
      id,
      conversationId,
      role: "user",
      content: request.content,
      createdAt: now,
    };

    const list = this.messages.get(conversationId) ?? [];
    list.push(message);
    this.messages.set(conversationId, list);

    const conv = this.conversations.get(conversationId)!;
    conv.messageCount = list.length;
    conv.updatedAt = now;
    this.conversations.set(conversationId, conv);

    return message;
  }

  addAssistantMessage(conversationId: string, content: string): MessageDto {
    const id = createId("msg");
    const now = new Date().toISOString();
    const message: MessageDto = {
      id,
      conversationId,
      role: "assistant",
      content,
      createdAt: now,
    };

    const list = this.messages.get(conversationId) ?? [];
    list.push(message);
    this.messages.set(conversationId, list);

    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.messageCount = list.length;
      conv.updatedAt = now;
    }

    return message;
  }
}
