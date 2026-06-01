"use client";

import { useEffect, useState } from "react";
import type {
  AgentInstanceDto,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubMessagePartDto,
  HubRunDto,
} from "@agenthub/shared";
import {
  ApiOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CommentOutlined,
  CopyOutlined,
  FileDoneOutlined,
  LoadingOutlined,
  MessageOutlined,
  PushpinFilled,
  PushpinOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { AgentReplyBlockModel } from "../../lib/workbench/types";
import {
  buildAgentReplyBlocks,
  eventText,
  messageToReplyBlock,
  payloadString,
  runStageLabel,
} from "../../lib/workbench/timeline";
import { agentColor, formatElapsed, formatTime, initials, isRunning } from "../../lib/workbench/format";
import { MessageParts, RichText } from "./rich-text";

export function TimelineMessage({
  message,
  onPin,
  onPinPart,
  onReply,
  onRegenerate,
  onOpenArtifact,
  agents,
}: {
  message: HubMessageDto;
  onPin: (message: HubMessageDto) => void;
  onPinPart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onReply?: (message: HubMessageDto) => void;
  onRegenerate?: (message: HubMessageDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
  agents: AgentInstanceDto[];
}) {
  if (message.role === "user") {
    return (
      <UserMessage
        message={message}
        onPin={onPin}
        onPinPart={onPinPart}
        onReply={onReply}
        onRegenerate={onRegenerate}
        onOpenArtifact={onOpenArtifact}
      />
    );
  }
  const canRegenerate = canRegenerateMessage(message);
  return (
    <AgentReplyBlock
      block={messageToReplyBlock(message, agents)}
      onPinPart={(part) => onPinPart?.(message, part)}
      onReply={onReply ? () => onReply(message) : undefined}
      onRegenerate={canRegenerate && onRegenerate ? () => onRegenerate(message) : undefined}
      onOpenArtifact={onOpenArtifact}
    />
  );
}

export function RunThread({
  run,
  events,
  fileChanges,
  messages,
  agents,
  onPinPart,
  onReply,
  onRegenerate,
  onApplyFileChange,
  onOpenArtifact,
  applyingFileChangeId,
}: {
  run: HubRunDto;
  events: HubEventDto[];
  fileChanges: HubFileChangeDto[];
  messages: HubMessageDto[];
  agents: AgentInstanceDto[];
  onPinPart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onReply?: (message: HubMessageDto) => void;
  onRegenerate?: (message: HubMessageDto) => void;
  onApplyFileChange?: (change: HubFileChangeDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
  applyingFileChangeId?: string | null;
}) {
  const persistedReplies = messages.filter((message) => message.role !== "user" && message.contentText.trim());
  const hasPersistedReplies = persistedReplies.length > 0 && !isRunning(run.status);
  const replyBlocks = hasPersistedReplies
    ? persistedReplies.map((message) => messageToReplyBlock(message, agents))
    : buildAgentReplyBlocks(events, agents);
  const activityEvents = events.filter((event) => event.eventType !== "message.delta");

  return (
    <section className="runThread">
      <div className="runThreadTop">
        <span>Run · {formatTime(run.createdAt)}</span>
        <RunBadge run={run} />
      </div>
      {replyBlocks.map((block) => {
        const message = block.messageId ? messages.find((item) => item.id === block.messageId) : undefined;
        return (
          <AgentReplyBlock
            key={block.id}
            block={block}
            onPinPart={(part) => {
              if (message) onPinPart?.(message, part);
            }}
            onReply={message && onReply ? () => onReply(message) : undefined}
            onRegenerate={message && canRegenerateMessage(message) && onRegenerate ? () => onRegenerate(message) : undefined}
            onOpenArtifact={onOpenArtifact}
          />
        );
      })}
      {fileChanges.length > 0 && (
        <RunDiffCards
          changes={fileChanges}
          applyingId={applyingFileChangeId}
          onApply={onApplyFileChange}
        />
      )}
      {activityEvents.length > 0 && <RunActivityTimeline events={activityEvents} defaultOpen={isRunning(run.status)} />}
      {isRunning(run.status) && <RunStatusPill run={run} events={events} />}
      {run.status === "failed" && <RunFailureBlock run={run} events={events} />}
    </section>
  );
}

function RunDiffCards({
  changes,
  applyingId,
  onApply,
}: {
  changes: HubFileChangeDto[];
  applyingId?: string | null;
  onApply?: (change: HubFileChangeDto) => void;
}) {
  return (
    <div className="runDiffCards">
      {changes.map((change) => (
        <details className="runDiffCard" key={change.id}>
          <summary>
            <span>
              <BranchesOutlined />
              <strong>{change.path}</strong>
            </span>
            <code>{change.changeType}</code>
          </summary>
          <div className="runDiffBody">
            <pre>{change.patch ?? buildBeforeAfterPreview(change)}</pre>
            {onApply && (
              <button
                className="ghostButton"
                type="button"
                disabled={applyingId === change.id}
                onClick={() => onApply(change)}
              >
                <CheckCircleOutlined />
                <span>{applyingId === change.id ? "应用中" : "应用 Diff"}</span>
              </button>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

export function RunBadge({ run }: { run: HubRunDto }) {
  return (
    <div className={`runBadge ${run.status}`}>
      {isRunning(run.status) ? <LoadingOutlined /> : run.status === "completed" ? <CheckCircleOutlined /> : <MessageOutlined />}
      <span>{run.status}</span>
    </div>
  );
}

function UserMessage({
  message,
  onPin,
  onPinPart,
  onReply,
  onRegenerate,
  onOpenArtifact,
}: {
  message: HubMessageDto;
  onPin: (message: HubMessageDto) => void;
  onPinPart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onReply?: (message: HubMessageDto) => void;
  onRegenerate?: (message: HubMessageDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  return (
    <article className="timelineRow userRow">
      <div className="bubble userBubble">
        <div className="bubbleMeta">
          <span>你 · {formatTime(message.createdAt)}</span>
          <button type="button" title={message.isPinned ? "取消 Pin" : "Pin 到上下文"} onClick={() => onPin(message)}>
            {message.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
          </button>
          {onReply && (
            <button type="button" title="回复/引用" onClick={() => onReply(message)}>
              <CommentOutlined />
            </button>
          )}
          {onRegenerate && (
            <button type="button" title="重新生成" onClick={() => onRegenerate(message)}>
              <ReloadOutlined />
            </button>
          )}
          <button type="button" title="复制消息" onClick={() => copyText(message.contentText)}>
            <CopyOutlined />
          </button>
        </div>
        {referenceCount(message) > 0 && <div className="messageReferenceHint">引用 {referenceCount(message)} 条上下文</div>}
        <MessageParts
          parts={message.parts}
          fallbackText={message.contentText}
          onPinPart={onPinPart ? (part) => onPinPart(message, part) : undefined}
          onOpenArtifact={onOpenArtifact}
        />
      </div>
    </article>
  );
}

function AgentReplyBlock({
  block,
  onPinPart,
  onReply,
  onRegenerate,
  onOpenArtifact,
}: {
  block: AgentReplyBlockModel;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReply?: () => void;
  onRegenerate?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const streaming = block.status === "thinking" || block.status === "streaming" || block.status === "queued";
  return (
    <article className="agentReply">
      <span className="avatar" style={{ background: agentColor(block.speakerId ?? block.name) }}>
        {streaming ? <LoadingOutlined /> : initials(block.name)}
      </span>
      <div className="agentReplyBody">
        <div className="bubbleMeta">
          <span>{block.name} · {formatTime(block.timestamp)}</span>
          {streaming && <small className="statusTag">生成中...</small>}
          {block.status === "failed" && <small className="statusTag error">失败</small>}
          {!streaming && onReply && (
            <button type="button" title="回复/引用" onClick={onReply}>
              <CommentOutlined />
            </button>
          )}
          {!streaming && onRegenerate && (
            <button type="button" title="重新生成" onClick={onRegenerate}>
              <ReloadOutlined />
            </button>
          )}
          <button type="button" title="复制消息" onClick={() => copyText(block.text)}>
            <CopyOutlined />
          </button>
        </div>
        {block.parts?.length ? (
          <MessageParts
            parts={block.parts}
            fallbackText={block.text}
            onPinPart={block.messageId ? onPinPart : undefined}
            onOpenArtifact={onOpenArtifact}
          />
        ) : (
          <RichText text={block.text} />
        )}
      </div>
    </article>
  );
}

function RunActivityTimeline({ events, defaultOpen }: { events: HubEventDto[]; defaultOpen: boolean }) {
  return (
    <details className="runActivity" open={defaultOpen}>
      <summary>
        <span>运行时间线</span>
        <small>{events.length} events</small>
      </summary>
      <div className="runActivityList">
        {events.map((event) => (
          <RunActivityEvent key={event.id} event={event} />
        ))}
      </div>
    </details>
  );
}

function RunActivityEvent({ event }: { event: HubEventDto }) {
  return (
    <div className={`runActivityEvent ${activityVariant(event)}`}>
      <span className="activityIcon">{activityIcon(event)}</span>
      <div>
        <strong>{activityTitle(event)}</strong>
        <small>{event.eventType} · {formatTime(event.occurredAt ?? event.persistedAt)}</small>
      </div>
    </div>
  );
}

function RunStatusPill({ run, events }: { run: HubRunDto; events: HubEventDto[] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const anchor = Date.parse(run.startedAt ?? run.createdAt);
  const elapsed = Number.isFinite(anchor) ? Math.max(0, Math.floor((now - anchor) / 1000)) : 0;

  return (
    <div className="runStatusPill" aria-live="polite">
      <LoadingOutlined />
      <span className="statusShimmer">{runStageLabel(run, events)}</span>
      <small>{formatElapsed(elapsed)}</small>
    </div>
  );
}

function RunFailureBlock({ run, events }: { run: HubRunDto; events: HubEventDto[] }) {
  const failedEvent = [...events].reverse().find((event) => event.eventType === "run.failed");
  const raw = run.errorMessage ?? (failedEvent ? eventText(failedEvent) : "未知错误");
  return (
    <details className="runFailure" open>
      <summary>运行失败</summary>
      <pre>{raw}</pre>
    </details>
  );
}

function activityVariant(event: HubEventDto) {
  if (event.eventType.includes("failed")) return "danger";
  if (event.eventType.includes("completed")) return "success";
  if (event.eventType === "file.change" || event.eventType.startsWith("artifact")) return "artifact";
  return "normal";
}

function activityIcon(event: HubEventDto) {
  if (event.eventType.includes("failed")) return <CloseCircleOutlined />;
  if (event.eventType.includes("completed")) return <CheckCircleOutlined />;
  if (event.eventType === "file.change") return <CodeOutlined />;
  if (event.eventType.startsWith("artifact")) return <FileDoneOutlined />;
  if (event.eventType.startsWith("tool")) return <ApiOutlined />;
  return <MessageOutlined />;
}

function activityTitle(event: HubEventDto) {
  if (event.eventType === "tool.call") return `调用 ${payloadString(event.payload, "tool") ?? "工具"}`;
  if (event.eventType === "tool.result") return `工具返回 ${payloadString(event.payload, "status") ?? "结果"}`;
  if (event.eventType === "file.change") return payloadString(event.payload, "path") ?? "文件变更";
  if (event.eventType.startsWith("artifact")) return payloadString(event.payload, "title") ?? "Artifact 更新";
  if (event.eventType === "run.completed") return "Run 完成";
  if (event.eventType === "run.failed") return "Run 失败";
  if (event.eventType === "run.cancelled") return "Run 已取消";
  return payloadString(event.payload, "message") ?? payloadString(event.payload, "status") ?? event.eventType;
}

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

function buildBeforeAfterPreview(change: HubFileChangeDto) {
  const before = change.beforeContent ? `--- before\n${change.beforeContent}` : "";
  const after = change.afterContent ? `+++ after\n${change.afterContent}` : "";
  return [before, after].filter(Boolean).join("\n\n") || "Diff 内容为空";
}

function referenceCount(message: HubMessageDto) {
  const refs = message.contentJson.references;
  return Array.isArray(refs) ? refs.length : message.contentJson.quotedMessageId ? 1 : 0;
}

function canRegenerateMessage(message: HubMessageDto) {
  return message.role === "assistant" || message.role === "agent";
}
