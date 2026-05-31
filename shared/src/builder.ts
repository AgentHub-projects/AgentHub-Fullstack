import type { AgentTemplateDto, ISODateString } from "./hub";

export interface StartBuildRequest {
  description: string; // 用户对想要创建的 Agent 的简短描述
}

export interface StartBuildResponse {
  buildId: string;
  userMessage: BuildMessageDto; // 用户发送的消息
  message: BuildMessageDto; // Builder 的第一条回复
}

export interface BuildSessionDto {
  id: string;
  status: string; // active | completed | cancelled
  context: Record<string, unknown>;
  agentTemplateId?: number | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface BuildSessionListItemDto {
  id: string;
  status: string;
  title: string;
  messageCount: number;
  agentTemplateId?: number | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ListBuildSessionsResponse {
  items: BuildSessionListItemDto[];
}

export interface BuildMessageDto {
  id: string;
  buildSessionId: string;
  role: string; // user | assistant
  content: string;
  options?: string[];
  draft?: BuildTemplateDraft | null;
  createdAt: ISODateString;
}

export interface SendBuildMessageRequest {
  message: string;
}

export interface SendBuildMessageResponse {
  userMessage: BuildMessageDto; // 用户发送的消息
  message: BuildMessageDto;
  context: Record<string, unknown>; // 当前收集到的字段
}

export interface BuildTemplateDraft {
  name: string;
  description: string;
  systemPrompt: string;
  defaultProvider: string;
}

export interface ConfirmBuildRequest {
  name: string;
  description: string;
  systemPrompt: string;
  defaultProvider: string;
}

export interface ConfirmBuildResponse {
  template: AgentTemplateDto;
}
