import type { ContextSnapshotItem } from "./hub";

export interface DownstreamInitializeParams {
  protocolVersion: string;
  clientInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

export type DownstreamPromptMode = "bootstrap" | "incremental";

export interface DownstreamPromptAgentBrief {
  agentId: string;
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
  agentId: string;
  mode: DownstreamPromptMode;
  prompt: string;
  pins: ContextSnapshotItem[];
  memory?: DownstreamPromptMemory;
  orchestratorSystemPrompt?: string;
  agents?: DownstreamPromptAgentBrief[];
  metadata?: Record<string, unknown>;
}
