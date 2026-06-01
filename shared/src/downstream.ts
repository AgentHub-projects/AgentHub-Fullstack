import type { AgentId, ContextSnapshotItem } from "./hub";

export interface DownstreamInitializeParams {
  protocolVersion: string;
  clientInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

export type DownstreamPromptMode = "bootstrap" | "incremental";

export interface DownstreamPromptAgentBrief {
  agentId: AgentId;
  description: string;
}

export interface DownstreamPromptMemory {
  summary: string;
  recent: ContextSnapshotItem[];
  retrieved: ContextSnapshotItem[];
}

export interface DownstreamPromptPart {
  type: "text";
  text: string;
}

export interface DownstreamPromptInput {
  sessionId: string;
  agenthubSessionId: string;
  runId: string;
  messageId: string;
  agentId: AgentId;
  promptMode: DownstreamPromptMode;
  prompt: DownstreamPromptPart[];
  mentionedAgentIds?: AgentId[];
  pins?: ContextSnapshotItem[];
  memory?: DownstreamPromptMemory;
  orchestratorSystemPrompt?: string;
  agents?: DownstreamPromptAgentBrief[];
  contextSnapshotId?: string | null;
  messageContext?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
