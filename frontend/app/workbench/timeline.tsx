"use client";

import { useEffect, useState } from "react";
import type {
  AgentInstanceDto,
  HubArtifactDto,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubMessagePartDto,
  HubRunDto,
} from "@agenthub/shared";
import {
  BranchesOutlined,
  CheckCircleOutlined,
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
  runStageLabel,
} from "../../lib/workbench/timeline";
import {
  formatElapsed,
  formatTime,
  isRunning,
} from "../../lib/workbench/format";
import type { AuthUserDto } from "@agenthub/shared";
import { AvatarFace } from "./avatar";
import { MessageParts, RichText } from "./rich-text";

export function TimelineMessage({
  message,
  onPin,
  onPinPart,
  onReply,
  onReferencePart,
  onRegenerate,
  onOpenArtifact,
  onOpenPart,
  onOpenDiffPanel,
  onOpenArtifactsPanel,
  agents,
  currentUser,
}: {
  message: HubMessageDto;
  onPin: (message: HubMessageDto) => void;
  onPinPart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onReply?: (message: HubMessageDto) => void;
  onReferencePart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onRegenerate?: (message: HubMessageDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
  onOpenDiffPanel?: () => void;
  onOpenArtifactsPanel?: () => void;
  agents: AgentInstanceDto[];
  currentUser?: AuthUserDto | null;
}) {
  if (message.role === "user") {
    return (
      <UserMessage
        message={message}
        onPin={onPin}
        onPinPart={onPinPart}
        onReply={onReply}
        onReferencePart={onReferencePart}
        onRegenerate={onRegenerate}
        onOpenArtifact={onOpenArtifact}
        onOpenPart={onOpenPart}
        onOpenDiffPanel={onOpenDiffPanel}
        onOpenArtifactsPanel={onOpenArtifactsPanel}
        currentUser={currentUser}
      />
    );
  }
  const canRegenerate = canRegenerateMessage(message);
  return (
    <AgentReplyBlock
      block={messageToReplyBlock(message, agents)}
      onPinPart={(part) => onPinPart?.(message, part)}
      onReferencePart={(part) => onReferencePart?.(message, part)}
      onReply={onReply ? () => onReply(message) : undefined}
      onRegenerate={canRegenerate && onRegenerate ? () => onRegenerate(message) : undefined}
      onOpenArtifact={onOpenArtifact}
      onOpenPart={onOpenPart}
      onOpenDiffPanel={onOpenDiffPanel}
      onOpenArtifactsPanel={onOpenArtifactsPanel}
    />
  );
}

export function RunThread({
  run,
  events,
  fileChanges,
  artifacts,
  messages,
  agents,
  currentUser,
  onPinPart,
  onReply,
  onReferencePart,
  onRegenerate,
  onOpenArtifact,
  onOpenPart,
  onOpenDiffPanel,
  onOpenArtifactsPanel,
}: {
  run: HubRunDto;
  events: HubEventDto[];
  fileChanges: HubFileChangeDto[];
  artifacts: HubArtifactDto[];
  messages: HubMessageDto[];
  agents: AgentInstanceDto[];
  currentUser?: AuthUserDto | null;
  onPinPart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onReply?: (message: HubMessageDto) => void;
  onReferencePart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onRegenerate?: (message: HubMessageDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
  onOpenDiffPanel?: () => void;
  onOpenArtifactsPanel?: () => void;
}) {
  const persistedReplies = messages.filter((message) => message.role !== "user" && message.contentText.trim());
  const hasPersistedReplies = persistedReplies.length > 0 && !isRunning(run.status);
  const replyBlocks = hasPersistedReplies
    ? persistedReplies.map((message) => messageToReplyBlock(message, agents))
    : buildAgentReplyBlocks(events, agents);

  return (
    <section className="runThread">
      {replyBlocks.map((block) => {
        const message = block.messageId ? messages.find((item) => item.id === block.messageId) : undefined;
        return (
          <AgentReplyBlock
            key={block.id}
            block={block}
            onPinPart={(part) => {
              if (message) onPinPart?.(message, part);
            }}
            onReferencePart={(part) => {
              if (message) onReferencePart?.(message, part);
            }}
            onReply={message && onReply ? () => onReply(message) : undefined}
            onRegenerate={message && canRegenerateMessage(message) && onRegenerate ? () => onRegenerate(message) : undefined}
            onOpenArtifact={onOpenArtifact}
            onOpenPart={onOpenPart}
            onOpenDiffPanel={onOpenDiffPanel}
            onOpenArtifactsPanel={onOpenArtifactsPanel}
          />
        );
      })}
      {(fileChanges.length > 0 || artifacts.length > 0) && (
        <RunOutputLinks
          fileChangeCount={fileChanges.length}
          artifactCount={artifacts.length}
          onOpenDiffPanel={onOpenDiffPanel}
          onOpenArtifactsPanel={onOpenArtifactsPanel}
        />
      )}
      {isRunning(run.status) && <RunStatusPill run={run} events={events} />}
      {run.status === "failed" && <RunFailureBlock run={run} events={events} />}
    </section>
  );
}

function RunOutputLinks({
  fileChangeCount,
  artifactCount,
  onOpenDiffPanel,
  onOpenArtifactsPanel,
}: {
  fileChangeCount: number;
  artifactCount: number;
  onOpenDiffPanel?: () => void;
  onOpenArtifactsPanel?: () => void;
}) {
  return (
    <div className="runOutputLinks">
      <span>本次运行产出</span>
      <div>
        {fileChangeCount > 0 && (
          <button type="button" onClick={onOpenDiffPanel} disabled={!onOpenDiffPanel}>
            <BranchesOutlined />
            <span>main 审查 · {fileChangeCount}</span>
          </button>
        )}
        {artifactCount > 0 && (
          <button type="button" onClick={onOpenArtifactsPanel} disabled={!onOpenArtifactsPanel}>
            <FileDoneOutlined />
            <span>右侧 Artifacts · {artifactCount}</span>
          </button>
        )}
      </div>
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
  onReferencePart,
  onRegenerate,
  onOpenArtifact,
  onOpenPart,
  onOpenDiffPanel,
  onOpenArtifactsPanel,
  currentUser,
}: {
  message: HubMessageDto;
  onPin: (message: HubMessageDto) => void;
  onPinPart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onReply?: (message: HubMessageDto) => void;
  onReferencePart?: (message: HubMessageDto, part: HubMessagePartDto) => void;
  onRegenerate?: (message: HubMessageDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
  onOpenDiffPanel?: () => void;
  onOpenArtifactsPanel?: () => void;
  currentUser?: AuthUserDto | null;
}) {
  const userName = currentUser?.displayName?.trim() || currentUser?.username || "我";
  return (
    <article className="timelineRow userRow">
      <div className="bubble userBubble">
        <div className="bubbleMeta">
          <span>你 · {formatTime(message.createdAt)}</span>
          <button type="button" title={message.isPinned ? "取消 Pin" : "Pin 为关键消息"} onClick={() => onPin(message)}>
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
        {referenceCount(message) > 0 && <div className="messageReferenceHint">引用 {referenceCount(message)} 条消息</div>}
        <MessageParts
          parts={message.parts}
          fallbackText={message.contentText}
          onPinPart={onPinPart ? (part) => onPinPart(message, part) : undefined}
          onReferencePart={onReferencePart ? (part) => onReferencePart(message, part) : undefined}
          onOpenArtifact={onOpenArtifact}
          onOpenPart={onOpenPart}
          onOpenDiffPanel={onOpenDiffPanel}
          onOpenArtifactsPanel={onOpenArtifactsPanel}
        />
      </div>
      <AvatarFace
        className="userAvatar"
        name={userName}
        avatarUrl={currentUser?.avatarUrl}
        colorKey={currentUser?.userId ?? userName}
      />
    </article>
  );
}

function AgentReplyBlock({
  block,
  onPinPart,
  onReferencePart,
  onReply,
  onRegenerate,
  onOpenArtifact,
  onOpenPart,
  onOpenDiffPanel,
  onOpenArtifactsPanel,
}: {
  block: AgentReplyBlockModel;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReferencePart?: (part: HubMessagePartDto) => void;
  onReply?: () => void;
  onRegenerate?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
  onOpenDiffPanel?: () => void;
  onOpenArtifactsPanel?: () => void;
}) {
  const streaming = block.status === "thinking" || block.status === "streaming" || block.status === "queued";
  return (
    <article className="agentReply">
      {streaming ? (
        <AvatarFace name={block.name} avatarUrl={block.avatarUrl} colorKey={block.speakerId ?? block.name}>
          <LoadingOutlined />
        </AvatarFace>
      ) : (
        <AvatarFace name={block.name} avatarUrl={block.avatarUrl} colorKey={block.speakerId ?? block.name} />
      )}
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
            onReferencePart={block.messageId ? onReferencePart : undefined}
            onOpenArtifact={onOpenArtifact}
            onOpenPart={onOpenPart}
            onOpenDiffPanel={onOpenDiffPanel}
            onOpenArtifactsPanel={onOpenArtifactsPanel}
          />
        ) : (
          <RichText text={block.text} />
        )}
      </div>
    </article>
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

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

function referenceCount(message: HubMessageDto) {
  const refs = message.contentJson.references;
  return Array.isArray(refs) ? refs.length : message.contentJson.quotedMessageId ? 1 : 0;
}

function canRegenerateMessage(message: HubMessageDto) {
  return message.role === "assistant" || message.role === "agent";
}
