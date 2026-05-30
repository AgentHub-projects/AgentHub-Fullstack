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
  retrieved: ContextSnapshotItem[];
}

export interface DownstreamPromptInput {
  agenthubSessionId: string;
  runId: string;
  messageId: string;
  agentId: AgentId;
  mode: DownstreamPromptMode;
  prompt: string;
  pins: ContextSnapshotItem[];
  memory?: DownstreamPromptMemory;
  orchestratorSystemPrompt?: string;
  agents?: DownstreamPromptAgentBrief[];
  metadata?: Record<string, unknown>;
}
