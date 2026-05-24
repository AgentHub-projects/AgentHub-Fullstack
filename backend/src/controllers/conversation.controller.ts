import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import type { ConversationDto, CreateConversationRequest, CreateMessageRequest, MessageDto } from "@agenthub/shared";
import { ConversationService } from "../services/conversation.service";

@Controller()
export class ConversationController {
  constructor(@Inject(ConversationService) private readonly conversations: ConversationService) {}

  @Get("conversations")
  listConversations(): { items: ConversationDto[] } {
    return this.conversations.list();
  }

  @Post("conversations")
  createConversation(@Body() body: CreateConversationRequest): ConversationDto {
    return this.conversations.create(body);
  }

  @Get("conversations/:id")
  getConversation(@Param("id") id: string): ConversationDto {
    return this.conversations.get(id);
  }

  @Delete("conversations/:id")
  deleteConversation(@Param("id") id: string): { ok: boolean } {
    return this.conversations.delete(id);
  }

  @Get("conversations/:id/messages")
  listMessages(@Param("id") id: string): { conversationId: string; items: MessageDto[] } {
    return this.conversations.listMessages(id);
  }

  @Post("conversations/:id/messages")
  createMessage(@Param("id") id: string, @Body() body: CreateMessageRequest): MessageDto {
    return this.conversations.createMessage(id, body);
  }
}
