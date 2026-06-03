import type {
  AgentInstanceDto,
  HubArtifactDto,
  HubEventDto,
  HubMessageDto,
  HubRunDto,
  SessionDetailDto,
} from "@agenthub/shared";
import type { AgentReplyBlockModel, ConversationItem } from "./types";
import { isRunning, sortArtifact, sortEvent, sortFileChange, sortMessage, sortRun } from "./format";

export function buildConversationItems(detail: SessionDetailDto | null): ConversationItem[] {
  if (!detail) return [];

  const messages = [...detail.messages].sort(sortMessage);
  const runs = [...detail.runs].sort(sortRun);
  const eventsByRun = new Map<string, HubEventDto[]>();
  const fileChangesByRun = new Map<string, typeof detail.fileChanges>();
  const artifactsByRun = new Map<string, HubArtifactDto[]>();
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const attachedArtifactIds = attachedMessageArtifactIds(messages);
  const claimedMessageIds = new Set<string>();
  const items: ConversationItem[] = [];

  for (const event of detail.events) {
    const current = eventsByRun.get(event.runId) ?? [];
    current.push(event);
    eventsByRun.set(event.runId, current);
  }

  for (const change of detail.fileChanges) {
    const current = fileChangesByRun.get(change.runId) ?? [];
    current.push(change);
    fileChangesByRun.set(change.runId, current);
  }

  for (const artifact of detail.artifacts) {
    if (!artifact.runId || attachedArtifactIds.has(artifact.id)) continue;
    const current = artifactsByRun.get(artifact.runId) ?? [];
    current.push(artifact);
    artifactsByRun.set(artifact.runId, current);
  }

  for (const run of runs) {
    const associatedMessages = messages.filter((message) => message.runId === run.id);
    const userMessage =
      (run.userMessageId ? messagesById.get(run.userMessageId) : undefined) ??
      associatedMessages.find((message) => message.role === "user");
    const runMessages = associatedMessages.filter((message) => message.id !== userMessage?.id);
    const runEvents = [...(eventsByRun.get(run.id) ?? [])].sort(sortEvent);
    const runFileChanges = [...(fileChangesByRun.get(run.id) ?? [])].sort(sortFileChange);
    const runArtifacts = [...(artifactsByRun.get(run.id) ?? [])].sort(sortArtifact);
    const shouldShowRun =
      runMessages.length > 0 ||
      runEvents.length > 0 ||
      runFileChanges.length > 0 ||
      runArtifacts.length > 0 ||
      isRunning(run.status) ||
      run.status === "failed";

    if (userMessage) {
      claimedMessageIds.add(userMessage.id);
      items.push({ kind: "message", id: userMessage.id, ts: userMessage.createdAt, message: userMessage });
    }
    for (const message of runMessages) claimedMessageIds.add(message.id);
    if (shouldShowRun) {
      items.push({
        kind: "run",
        id: run.id,
        ts: userMessage?.createdAt ?? run.createdAt,
        run,
        events: runEvents,
        messages: runMessages,
        fileChanges: runFileChanges,
        artifacts: runArtifacts,
      });
    }
  }

  for (const message of messages) {
    if (!claimedMessageIds.has(message.id)) {
      items.push({ kind: "message", id: message.id, ts: message.createdAt, message });
    }
  }

  return items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

function attachedMessageArtifactIds(messages: HubMessageDto[]) {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== "artifact") continue;
      const artifactId = part.metadata?.artifactId;
      if (typeof artifactId === "string" && artifactId.trim()) ids.add(artifactId);
    }
  }
  return ids;
}

export function buildAgentReplyBlocks(events: HubEventDto[], agents: AgentInstanceDto[]): AgentReplyBlockModel[] {
  const blocks: AgentReplyBlockModel[] = [];
  for (const event of events) {
    if (event.eventType !== "message.delta" || event.visibility === "private") continue;
    const text = eventText(event);
    if (!text.trim()) continue;
    const speaker = resolveSpeaker(event, agents);
    const append = event.payload.append !== false;
    const last = blocks.at(-1);
    if (append && last?.speakerId === speaker.speakerId) {
      last.text = `${last.text}${text}`;
      last.timestamp = event.occurredAt ?? event.persistedAt;
      continue;
    }
    blocks.push({
      id: event.id,
      speakerId: speaker.speakerId,
      name: speaker.name,
      text,
      timestamp: event.occurredAt ?? event.persistedAt,
    });
  }
  return blocks;
}

export function resolveSpeaker(event: HubEventDto, agents: AgentInstanceDto[]) {
  const payloadSpeaker = typeof event.payload.speaker === "string" ? event.payload.speaker : null;
  const payloadAgentId = payloadSpeaker && /^\d+$/.test(payloadSpeaker) ? Number(payloadSpeaker) : null;
  const speakerId = event.speakerAgentId ?? payloadAgentId ?? payloadSpeaker;
  const agent = typeof speakerId === "number" ? agents.find((item) => item.id === speakerId) : undefined;
  return {
    speakerId,
    name: event.speakerName ?? agent?.name ?? "Orchestrator",
  };
}

export function runStageLabel(run: HubRunDto, events: HubEventDto[]) {
  if (run.status === "queued") return "等待调度";
  if (run.status === "context_building") return "准备资料";
  if (run.status === "connecting") return "连接 Orchestrator";
  if (run.status !== "running") return run.status;

  const latest = [...events].reverse().find((event) => event.eventType !== "run.status" && event.eventType !== "run.created");
  if (!latest) return "正在思考";
  if (latest.eventType === "message.delta") return "正在生成回复";
  if (latest.eventType === "tool.call") return `调用 ${payloadString(latest.payload, "tool") ?? "工具"}`;
  if (latest.eventType === "tool.result") return "处理工具结果";
  if (latest.eventType === "file.change") return "写入文件变更";
  if (latest.eventType.startsWith("artifact")) return "生成 artifact";
  return "运行中";
}

export function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function eventText(event: HubEventDto) {
  const value = event.payload.text ?? event.payload.content ?? event.payload.message ?? event.payload.delta ?? event.payload.status;
  return typeof value === "string" ? value : JSON.stringify(event.payload, null, 2);
}

export function messageToReplyBlock(message: HubMessageDto, agents: AgentInstanceDto[]): AgentReplyBlockModel {
  const agent = agents.find((item) => item.id === message.agentId);
  return {
    id: message.id,
    messageId: message.id,
    speakerId: message.agentId,
    name: message.agentName ?? agent?.name ?? "Agent",
    text: message.contentText,
    parts: message.parts,
    timestamp: message.createdAt,
    status: message.status,
  };
}
