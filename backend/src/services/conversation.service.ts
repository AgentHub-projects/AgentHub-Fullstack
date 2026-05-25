import { Injectable } from "@nestjs/common";
import { DEFAULT_WORKSPACE_PATH } from "@agenthub/shared";
import type {
  ConversationDto,
  CreateConversationRequest,
  CreateMessageRequest,
  PinMessageRequest,
  MessageDto,
  UpdateConversationRequest,
} from "@agenthub/shared";
import { createId } from "./ids";

@Injectable()
export class ConversationService {
  private readonly conversations = new Map<string, ConversationDto>();
  private readonly messages = new Map<string, MessageDto[]>();

  list(): { items: ConversationDto[] } {
    const items = [...this.conversations.values()].sort(
      (a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      },
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
      workspacePath: request.workspacePath ?? DEFAULT_WORKSPACE_PATH,
      status: "idle",
      isPinned: false,
      isArchived: false,
      messageCount: 0,
      pinnedMessageIds: [],
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
      workspacePath: request.workspacePath ?? DEFAULT_WORKSPACE_PATH,
      status: "idle",
      isPinned: false,
      isArchived: false,
      messageCount: 0,
      pinnedMessageIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(id, conv);
    this.messages.set(id, []);
    return conv;
  }

  update(id: string, request: UpdateConversationRequest): ConversationDto {
    const conv = this.get(id);
    const now = new Date().toISOString();
    const updated: ConversationDto = {
      ...conv,
      ...(request.title !== undefined && { title: request.title }),
      ...(request.workspacePath !== undefined && { workspacePath: request.workspacePath }),
      ...(request.isPinned !== undefined && {
        isPinned: request.isPinned,
        pinnedAt: request.isPinned ? now : undefined,
      }),
      ...(request.isArchived !== undefined && {
        isArchived: request.isArchived,
        archivedAt: request.isArchived ? now : undefined,
      }),
      updatedAt: now,
    };
    this.conversations.set(id, updated);
    return updated;
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
      ...(request.agentId !== undefined && { agentId: request.agentId }),
      ...(request.quotedMessageId !== undefined && { quotedMessageId: request.quotedMessageId }),
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

  addAssistantMessage(conversationId: string, content: string, agentId?: string): MessageDto {
    const id = createId("msg");
    const now = new Date().toISOString();
    const message: MessageDto = {
      id,
      conversationId,
      role: "assistant",
      content,
      ...(agentId !== undefined && { agentId }),
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

  pinMessage(conversationId: string, messageId: string, request: PinMessageRequest): MessageDto {
    const conv = this.get(conversationId);
    const list = this.messages.get(conversationId) ?? [];
    const message = list.find((item) => item.id === messageId);
    if (!message) {
      throw Object.assign(new Error(`Message ${messageId} not found`), { statusCode: 404 });
    }

    message.pinned = request.pinned;
    const ids = new Set(conv.pinnedMessageIds);
    if (request.pinned) {
      ids.add(messageId);
    } else {
      ids.delete(messageId);
    }

    const now = new Date().toISOString();
    conv.pinnedMessageIds = [...ids];
    conv.updatedAt = now;
    this.conversations.set(conversationId, conv);
    return message;
  }
}
