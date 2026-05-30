import type { AgentTemplateDto, ISODateString } from "./hub";

export interface StartBuildRequest {
  description: string; // 用户对想要创建的 Agent 的简短描述
}

export interface StartBuildResponse {
  buildId: string;
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

export interface BuildMessageDto {
  id: string;
  buildSessionId: string;
  role: string; // user | assistant
  content: string;
  createdAt: ISODateString;
}

export interface SendBuildMessageRequest {
  message: string;
}

export interface SendBuildMessageResponse {
  message: BuildMessageDto;
  context: Record<string, unknown>; // 当前收集到的字段
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
