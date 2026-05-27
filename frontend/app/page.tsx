"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import type { AgentConfigDraft, AgentEvent, SessionDto } from "@agenthub/shared";
import {
  cancelAgentRun,
  connectSessionSocket,
  getCurrentSession,
  initialEvents,
  initialSession,
  runSession,
} from "../lib/agenthub-api";

type SocketState = "connecting" | "connected" | "disconnected" | "unavailable";
type TeamStatus = "view" | "active" | "waiting" | "done" | "error";
type ConversationMode = "direct" | "group";
type StepState = "waiting" | "active" | "done" | "error";
type ArtifactKind = "markdown" | "pdf" | "docx" | "image" | "text";

type AgentProfile = {
  id: string;
  name: string;
  shortName: string;
  role: string;
  provider: string;
  status: TeamStatus;
  accent: string;
};

type MergedMessage = {
  id: string;
  runId: string;
  agent: AgentProfile;
  text: string;
  status: "running" | "done" | "error" | "cancelled" | "idle";
  events: AgentEvent[];
  firstTs: number;
  lastTs: number;
};

type DiffFile = {
  id: string;
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};

type ArtifactPreview = {
  id: string;
  kind: ArtifactKind;
  title: string;
  source: string;
  path?: string;
  url?: string;
  content?: string;
};

const DEFAULT_PROMPT = "帮我写一个前后端分离的架构的todolist系统。";

const AGENT_DIRECTORY: AgentProfile[] = [
  {
    id: "claude",
    name: "Claude Code",
    shortName: "CC",
    role: "单聊执行入口 / 真实 run 状态",
    provider: "local-cli",
    status: "active",
    accent: "#2563eb",
  },
  {
    id: "orchestrator",
    name: "Orchestrator",
    shortName: "OR",
    role: "任务拆解与阶段汇总",
    provider: "frontend target",
    status: "view",
    accent: "#5f6f52",
  },
  {
    id: "frontend",
    name: "Frontend",
    shortName: "FE",
    role: "界面实现与 API 接线",
    provider: "frontend target",
    status: "waiting",
    accent: "#0f766e",
  },
  {
    id: "backend",
    name: "Backend",
    shortName: "BE",
    role: "会话 API / Socket",
    provider: "frontend target",
    status: "waiting",
    accent: "#8b5cf6",
  },
  {
    id: "review",
    name: "Review",
    shortName: "RV",
    role: "契约与回归审查",
    provider: "frontend target",
    status: "waiting",
    accent: "#a16207",
  },
  {
    id: "test",
    name: "Test",
    shortName: "TS",
    role: "typecheck / integration",
    provider: "frontend target",
    status: "waiting",
    accent: "#b42318",
  },
];

function formatTime(value: string | number | undefined) {
  if (value === undefined) {
    return "--:--";
  }

  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusLabel(status: SessionDto["status"]) {
  const labels: Record<SessionDto["status"], string> = {
    idle: "待命",
    running: "运行中",
    succeeded: "已完成",
    failed: "失败",
  };
  return labels[status];
}

function teamStatusLabel(status: TeamStatus) {
  const labels: Record<TeamStatus, string> = {
    view: "视图",
    active: "当前",
    waiting: "等待",
    done: "完成",
    error: "异常",
  };
  return labels[status];
}

function stepLabel(state: StepState) {
  const labels: Record<StepState, string> = {
    waiting: "等待",
    active: "进行中",
    done: "完成",
    error: "异常",
  };
  return labels[state];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readString(
  record: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringifyPayload(payload: unknown) {
  if (typeof payload === "string") {
    return payload;
  }

  return JSON.stringify(payload, null, 2);
}

function extractText(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }

  const record = asRecord(payload);
  const direct = readString(record, ["text", "message", "summary", "content"]);
  if (direct) {
    return direct;
  }

  const delta = asRecord(record?.delta);
  const deltaText = readString(delta, ["text", "content"]);
  if (deltaText) {
    return deltaText;
  }

  const output = record?.output;
  if (typeof output === "string") {
    return output;
  }

  const outputRecord = asRecord(output);
  return readString(outputRecord, ["text", "message", "summary"]);
}

function payloadSummary(event: AgentEvent) {
  const extracted = extractText(event.payload);
  if (extracted) {
    return extracted;
  }

  const payload = asRecord(event.payload);
  const status = readString(payload, ["status", "code", "mode"]);
  return status ?? event.type.replace(/_/g, " ");
}

function getAgentMeta(agentId: string | undefined) {
  if (!agentId) {
    return AGENT_DIRECTORY[0];
  }

  return (
    AGENT_DIRECTORY.find(
      (agent) => agent.id === agentId || agent.name === agentId,
    ) ?? {
      id: agentId,
      name: agentId,
      shortName: agentId.slice(0, 2).toUpperCase(),
      role: "后端事件来源",
      provider: "Socket AgentEvent",
      status: "view" as const,
      accent: "#334155",
    }
  );
}

function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]) {
  if (incoming.length === 0) {
    return current;
  }

  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) {
    byId.set(event.eventId, event);
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.seq !== b.seq) {
      return a.seq - b.seq;
    }
    return a.ts - b.ts;
  });
}

function appendMessageText(message: MergedMessage, text: string | undefined) {
  if (!text) {
    return;
  }
  message.text += text;
}

function buildMergedMessages(
  events: AgentEvent[],
  session: SessionDto,
): MergedMessage[] {
  const messages = new Map<string, MergedMessage>();

  for (const event of [...events].sort((a, b) => a.seq - b.seq || a.ts - b.ts)) {
    const key = event.messageId ?? `${event.runId}:${event.agentId}`;
    const agent = getAgentMeta(event.agentId);
    const existing = messages.get(key);
    const message =
      existing ??
      ({
        id: key,
        runId: event.runId,
        agent,
        text: "",
        status: "running",
        events: [],
        firstTs: event.ts,
        lastTs: event.ts,
      } satisfies MergedMessage);

    message.events.push(event);
    message.lastTs = event.ts;

    if (event.type === "text_delta") {
      appendMessageText(message, extractText(event.payload));
    }

    if (event.type === "agent_completed") {
      if (!message.text.trim()) {
        appendMessageText(message, extractText(event.payload));
      }
      message.status = "done";
    }

    if (event.type === "agent_failed") {
      const errorText = extractText(event.payload) ?? stringifyPayload(event.payload);
      message.text = message.text
        ? `${message.text}\n\n${errorText}`
        : errorText;
      message.status = "error";
    }

    if (event.type === "agent_cancelled") {
      message.status = "cancelled";
    }

    if (event.type === "done" && message.status === "running") {
      message.status = "done";
    }

    messages.set(key, message);
  }

  if (messages.size === 0 && (session.output || session.error || session.status === "running")) {
    const agent = getAgentMeta(session.agentId);
    return [
      {
        id: `${session.id}:snapshot`,
        runId: session.runIds.at(-1) ?? "snapshot",
        agent,
        text:
          session.output ??
          session.error ??
          "后端 run 已启动，正在等待 Socket text_delta。",
        status:
          session.status === "failed"
            ? "error"
            : session.status === "succeeded"
              ? "done"
              : "running",
        events: [],
        firstTs: new Date(session.updatedAt).getTime(),
        lastTs: new Date(session.updatedAt).getTime(),
      },
    ];
  }

  return Array.from(messages.values()).sort((a, b) => a.firstTs - b.firstTs);
}

function normalizeDiffEvent(event: AgentEvent): DiffFile[] {
  if (event.type !== "code_diff") {
    return [];
  }

  const payload = asRecord(event.payload);
  const payloadFiles = payload?.files;
  const candidates = Array.isArray(payloadFiles)
    ? payloadFiles
    : payload?.file
      ? [payload.file]
      : [event.payload];

  return candidates.flatMap((candidate, index) => {
    const record = asRecord(candidate);
    const path =
      readString(record, ["path", "filePath", "filename", "name"]) ??
      readString(payload, ["path", "filePath", "filename", "name"]);
    const patch =
      readString(record, ["patch", "diff", "content"]) ??
      readString(payload, ["patch", "diff", "content"]);

    if (!path && !patch) {
      return [];
    }

    return [
      {
        id: `${event.eventId}:${index}`,
        path: path ?? "inline.diff",
        status:
          readString(record, ["status", "changeType", "type"]) ??
          readString(payload, ["status", "changeType", "type"]) ??
          "modified",
        additions:
          asNumber(record?.additions) ?? asNumber(payload?.additions),
        deletions:
          asNumber(record?.deletions) ?? asNumber(payload?.deletions),
        patch,
      },
    ];
  });
}

function inferArtifactKind(
  descriptor: string | undefined,
  path: string | undefined,
  content: string | undefined,
): ArtifactKind {
  const value = `${descriptor ?? ""} ${path ?? ""}`.toLowerCase();
  if (value.includes("pdf") || value.endsWith(".pdf")) {
    return "pdf";
  }
  if (
    value.includes("docx") ||
    value.includes("word") ||
    value.endsWith(".doc") ||
    value.endsWith(".docx")
  ) {
    return "docx";
  }
  if (
    value.includes("image") ||
    value.endsWith(".png") ||
    value.endsWith(".jpg") ||
    value.endsWith(".jpeg") ||
    value.endsWith(".gif") ||
    value.endsWith(".webp")
  ) {
    return "image";
  }
  if (
    value.includes("markdown") ||
    value.endsWith(".md") ||
    value.endsWith(".mdx") ||
    content
  ) {
    return "markdown";
  }
  return "text";
}

function artifactFromRecord(
  record: Record<string, unknown>,
  source: string,
  fallbackId: string,
): ArtifactPreview {
  const path = readString(record, ["path", "filePath", "summaryPath"]);
  const url = readString(record, ["url", "href", "src"]);
  const content = readString(record, ["markdown", "content", "text", "body"]);
  const descriptor = readString(record, ["kind", "type", "mime", "mimeType"]);
  const title =
    readString(record, ["title", "name", "label"]) ??
    path ??
    url ??
    "Preview artifact";

  return {
    id: readString(record, ["id", "artifactId"]) ?? fallbackId,
    kind: inferArtifactKind(descriptor, path ?? url, content),
    title,
    source,
    path,
    url,
    content,
  };
}

function artifactsFromEvent(event: AgentEvent): ArtifactPreview[] {
  const payload = asRecord(event.payload);
  if (!payload) {
    return [];
  }

  const rawArtifacts = payload.artifacts;
  const rawPreview = payload.preview;
  const candidates =
    Array.isArray(rawArtifacts)
      ? rawArtifacts
      : rawPreview
        ? [rawPreview]
        : event.type === "preview_card"
          ? [payload]
          : [];

  return candidates.flatMap((candidate, index) => {
    const record = asRecord(candidate);
    if (!record) {
      return [];
    }
    return [artifactFromRecord(record, event.type, `${event.eventId}:${index}`)];
  });
}

function uniqueArtifacts(artifacts: ArtifactPreview[]) {
  const byId = new Map<string, ArtifactPreview>();
  for (const artifact of artifacts) {
    byId.set(artifact.id, artifact);
  }
  return Array.from(byId.values());
}

function mentionFor(agent: AgentProfile) {
  return `@${agent.name.replace(/\s+/g, "")}`;
}

function ArtifactPreviewPane({ artifact }: { artifact: ArtifactPreview | null }) {
  if (!artifact) {
    return (
      <div className="previewEmpty">
        <strong>暂无可预览 artifact</strong>
        <span>等待后端通过 preview_card 事件或 session.testSync 返回真实路径。</span>
      </div>
    );
  }

  if (artifact.kind === "image" && artifact.url) {
    return (
      <figure className="artifactPreview imagePreview">
        <img alt={artifact.title} src={artifact.url} />
        <figcaption>{artifact.path ?? artifact.url}</figcaption>
      </figure>
    );
  }

  if (artifact.kind === "pdf" && artifact.url) {
    return (
      <div className="artifactPreview framePreview">
        <iframe src={artifact.url} title={artifact.title} />
      </div>
    );
  }

  if (artifact.kind === "docx") {
    return (
      <div className="artifactPreview documentPreview">
        <strong>{artifact.title}</strong>
        <p>{artifact.path ?? artifact.url ?? "后端未提供可下载 URL。"}</p>
        <span>DOCX 以只读文件卡呈现；当前前端不伪造文档内容。</span>
      </div>
    );
  }

  return (
    <div className="artifactPreview markdownPreview">
      <div>
        <strong>{artifact.title}</strong>
        <span>{artifact.path ?? artifact.url ?? artifact.source}</span>
      </div>
      <pre>{artifact.content ?? "后端只返回了 artifact 元数据，暂未返回正文。"}</pre>
    </div>
  );
}

export default function WorkbenchPage() {
  const [session, setSession] = useState<SessionDto>(initialSession);
  const [events, setEvents] = useState<AgentEvent[]>(initialEvents);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [notice, setNotice] = useState("正在确认后端连接；不会展示 mock 成功结果。");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [mode, setMode] = useState<ConversationMode>("direct");
  const [sessionSearch, setSessionSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>(["claude"]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);

  const hasBackendSession = session.id !== initialSession.id;
  const isRunning = session.status === "running" || isSubmitting;
  const latestEvent = events.at(-1);
  const selectedAgents = useMemo(
    () =>
      selectedAgentIds
        .map((id) => AGENT_DIRECTORY.find((agent) => agent.id === id))
        .filter((agent): agent is AgentProfile => Boolean(agent)),
    [selectedAgentIds],
  );
  const primaryAgent = selectedAgents[0] ?? AGENT_DIRECTORY[0];

  const loadSession = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setIsRefreshing(true);
      }

      const result = await getCurrentSession();
      if (!options?.silent) {
        setIsRefreshing(false);
      }

      if (result.ok) {
        setRefreshError(null);
        if (result.data.session) {
          setSession(result.data.session);
          const latestRunId = result.data.session.runIds.at(-1) ?? null;
          setCurrentRunId((current) => current ?? latestRunId);
        }
        setEvents((current) => mergeEvents(current, result.data.events));
        if (!options?.silent) {
          setNotice("已从 GET /api/session/current 同步真实会话。");
        }
        return;
      }

      setRefreshError(result.error);
      if (!options?.silent) {
        setNotice(`后端未连接：GET /api/session/current ${result.error}`);
      }
    },
    [],
  );

  useEffect(() => {
    let ignore = false;

    async function refresh(silent = false) {
      if (ignore) {
        return;
      }
      await loadSession({ silent });
    }

    void refresh(false);
    const timer = window.setInterval(() => void refresh(true), 3500);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, [loadSession]);

  useEffect(() => {
    setSocketState("connecting");
    const disconnect = connectSessionSocket(
      session.id,
      (event) => setEvents((current) => mergeEvents(current, [event])),
      (state) => setSocketState(state),
    );

    return disconnect;
  }, [session.id]);

  const eventGroups = useMemo(() => {
    return events.reduce<
      Array<{ agent: AgentProfile; events: AgentEvent[]; key: string }>
    >((groups, event) => {
      const agent = getAgentMeta(event.agentId);
      const last = groups.at(-1);
      if (last?.agent.id === agent.id) {
        last.events.push(event);
        return groups;
      }

      groups.push({
        agent,
        events: [event],
        key: `${agent.id}-${event.eventId}`,
      });
      return groups;
    }, []);
  }, [events]);

  const mergedMessages = useMemo(
    () => buildMergedMessages(events, session),
    [events, session],
  );

  const diffFiles = useMemo(
    () => events.flatMap((event) => normalizeDiffEvent(event)),
    [events],
  );

  const artifacts = useMemo(() => {
    const eventArtifacts = events.flatMap((event) => artifactsFromEvent(event));
    const sessionArtifacts: ArtifactPreview[] = [];

    if (session.output) {
      sessionArtifacts.push({
        id: `${session.id}:output`,
        kind: "markdown",
        title: "Session output",
        source: "SessionDto.output",
        content: session.output,
      });
    }

    if (session.testSync?.summaryPath) {
      sessionArtifacts.push({
        id: `${session.id}:summary`,
        kind: inferArtifactKind(undefined, session.testSync.summaryPath, undefined),
        title: "Run summary",
        source: "SessionDto.testSync.summaryPath",
        path: session.testSync.summaryPath,
      });
    }

    return uniqueArtifacts([...eventArtifacts, ...sessionArtifacts]);
  }, [events, session]);

  const selectedArtifact =
    artifacts.find((artifact) => artifact.id === selectedArtifactId) ??
    artifacts[0] ??
    null;

  const visibleRunIds =
    session.runIds.length > 0 ? session.runIds.join(", ") : "后端暂未返回 runId";

  const contractFields = useMemo(
    () => [
      ["GET", "/api/session/current"],
      ["POST", "/api/session/run"],
      ["POST", "/api/agent-runs/:runId/cancel"],
      ["Socket", "agent:event / session:event"],
      ["SessionDto.id", session.id],
      ["SessionDto.status", session.status],
      ["SessionDto.agentId", session.agentId ?? primaryAgent.id],
      ["SessionDto.output", session.output ? "已返回" : "无后端输出"],
      ["SessionDto.error", session.error ?? "无"],
      ["SessionDto.runIds", visibleRunIds],
      ["RunSessionResponse.run.id", currentRunId ?? "等待后端返回"],
      ["testSync.status", session.testSync?.status ?? "pending"],
      ["testSync.targetBranch", session.testSync?.targetBranch ?? "main"],
      ["testSync.summaryPath", session.testSync?.summaryPath ?? "未返回"],
      ["AgentEvent.count", String(events.length)],
      ["AgentEvent.type", latestEvent?.type ?? "无事件"],
    ],
    [currentRunId, events.length, latestEvent, primaryAgent.id, session, visibleRunIds],
  );

  const sessionRecords = useMemo(
    () => [
      {
        id: session.id,
        title: session.title ?? "Current Session",
        status: session.status,
        prompt: session.prompt ?? prompt,
        updatedAt: session.updatedAt,
        archived: false,
        pinned: false,
        source: hasBackendSession ? "API" : "offline",
      },
    ],
    [hasBackendSession, prompt, session],
  );

  const filteredSessions = sessionRecords.filter((item) => {
    const haystack = `${item.title} ${item.prompt} ${item.status}`.toLowerCase();
    const matchesSearch = haystack.includes(sessionSearch.trim().toLowerCase());
    return matchesSearch && (showArchived || !item.archived);
  });

  const runSteps = useMemo(
    () => [
      {
        label: "Session",
        detail: hasBackendSession ? session.id : "offline",
        state: hasBackendSession ? "done" : isRefreshing ? "active" : "waiting",
      },
      {
        label: "Run",
        detail: currentRunId ?? "no run",
        state: session.status === "failed" ? "error" : isRunning ? "active" : session.runIds.length ? "done" : "waiting",
      },
      {
        label: "Stream",
        detail: `${events.length} events`,
        state: events.length ? "done" : isRunning ? "active" : "waiting",
      },
      {
        label: "Diff",
        detail: `${diffFiles.length} files`,
        state: diffFiles.length ? "done" : "waiting",
      },
      {
        label: "Artifacts",
        detail: `${artifacts.length} previews`,
        state:
          session.testSync?.status === "failed"
            ? "error"
            : artifacts.length
              ? "done"
              : "waiting",
      },
    ] satisfies Array<{ label: string; detail: string; state: StepState }>,
    [
      artifacts.length,
      currentRunId,
      diffFiles.length,
      events.length,
      hasBackendSession,
      isRefreshing,
      isRunning,
      session.id,
      session.runIds.length,
      session.status,
      session.testSync?.status,
    ],
  );

  function setConversationMode(nextMode: ConversationMode) {
    setMode(nextMode);
    if (nextMode === "direct") {
      setSelectedAgentIds(["claude"]);
      setNotice("已切换为单聊草稿；点击 Run 后调用现有后端 run API。");
      return;
    }

    setSelectedAgentIds(["orchestrator", "frontend", "backend", "review"]);
    setNotice("已切换为群聊草稿；后端当前仍是单 run，mentions 会随 prompt/config 发送。");
  }

  function toggleAgent(agentId: string) {
    if (mode === "direct") {
      setSelectedAgentIds([agentId]);
      return;
    }

    setSelectedAgentIds((current) => {
      if (current.includes(agentId)) {
        return current.length === 1
          ? current
          : current.filter((item) => item !== agentId);
      }
      return [...current, agentId];
    });
  }

  function insertMention(agent: AgentProfile) {
    const mention = mentionFor(agent);
    setPrompt((current) => {
      const needsSpace = current.length > 0 && !/\s$/.test(current);
      return `${current}${needsSpace ? " " : ""}${mention} `;
    });
    if (mode === "direct") {
      setSelectedAgentIds([agent.id]);
    } else if (!selectedAgentIds.includes(agent.id)) {
      setSelectedAgentIds((current) => [...current, agent.id]);
    }
  }

  function buildOutboundPrompt(value: string) {
    if (mode === "direct") {
      return value;
    }

    const mentionLine = selectedAgents.map((agent) => mentionFor(agent)).join(" ");
    if (!mentionLine) {
      return value;
    }
    return `${mentionLine}\n${value}`;
  }

  function buildRunConfig(): AgentConfigDraft {
    return {
      name: primaryAgent.id,
      provider: primaryAgent.provider,
      role:
        mode === "group"
          ? `Group coordinator for ${selectedAgents.map((agent) => agent.name).join(", ")}`
          : primaryAgent.role,
      tags: [mode, ...selectedAgents.map((agent) => agent.id)],
    };
  }

  async function handleRun() {
    const value = prompt.trim();
    if (!value) {
      setNotice("请输入任务口令。");
      return;
    }

    setIsSubmitting(true);
    setCurrentRunId(null);
    setEvents([]);
    setNotice("正在调用 POST /api/session/run，等待后端返回真实 run。");

    const result = await runSession(buildOutboundPrompt(value), buildRunConfig());
    setIsSubmitting(false);

    if (result.ok) {
      setSession(result.data.session);
      setCurrentRunId(result.data.run.id);
      setNotice("已启动真实 agent run；等待 Socket 流式事件。");
      return;
    }

    setSession((current) => ({
      ...current,
      status: "idle",
      prompt: value,
      output: undefined,
      error: undefined,
      updatedAt: new Date().toISOString(),
    }));
    setNotice(`后端未启动 run：POST /api/session/run ${result.error}`);
  }

  async function handleCancel() {
    if (!currentRunId) {
      setNotice("暂无可取消的 runId；Cancel 需要后端返回 RunSessionResponse.run.id。");
      return;
    }

    setIsCancelling(true);
    setNotice("正在调用 POST /api/agent-runs/:runId/cancel。");
    const result = await cancelAgentRun(currentRunId);
    setIsCancelling(false);

    if (result.ok) {
      setSession(result.data.session);
      setCurrentRunId(result.data.run.id);
      setNotice("已发送真实 Cancel 请求。");
      return;
    }

    setNotice(`Cancel 请求未完成：${result.error}`);
  }

  return (
    <main className="workspaceShell">
      <nav className="iconRail" aria-label="主导航">
        <div className="brandMark">A</div>
        <button className="railIcon active" type="button" title="Workbench">
          W
        </button>
        <button className="railIcon" type="button" title="Agents">
          G
        </button>
        <button className="railIcon" type="button" title="Artifacts">
          F
        </button>
        <span className={`railSocket ${socketState}`} title={socketState} />
      </nav>

      <aside className="sessionColumn" aria-label="会话与 Agent">
        <section className="columnTop">
          <div>
            <strong>AgentHub</strong>
            <span>IM Workbench</span>
          </div>
          <span className={`statusPill ${session.status}`}>
            {statusLabel(session.status)}
          </span>
        </section>

        <section className="panelBlock">
          <div className="sectionHeader">
            <span>Conversations</span>
            <small>{hasBackendSession ? "API current" : "offline"}</small>
          </div>
          <div className="conversationActions">
            <button
              className={mode === "direct" ? "active" : ""}
              onClick={() => setConversationMode("direct")}
              type="button"
            >
              Direct
            </button>
            <button
              className={mode === "group" ? "active" : ""}
              onClick={() => setConversationMode("group")}
              type="button"
            >
              Group
            </button>
          </div>
          <input
            aria-label="搜索会话"
            className="sessionSearch"
            onChange={(event) => setSessionSearch(event.target.value)}
            placeholder="Search current session"
            value={sessionSearch}
          />
          <label className="inlineCheck">
            <input
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
              type="checkbox"
            />
            Show archived
          </label>
          <div className="sessionList">
            {filteredSessions.length > 0 ? (
              filteredSessions.map((item) => (
                <button className="sessionCard active" key={item.id} type="button">
                  <span>{item.title}</span>
                  <small>{item.prompt}</small>
                  <i>
                    {item.source} · {statusLabel(item.status)} · {formatTime(item.updatedAt)}
                  </i>
                </button>
              ))
            ) : (
              <div className="emptyInline">没有匹配当前 API session。</div>
            )}
          </div>
          <div className="disabledActions" aria-label="尚未支持的会话操作">
            <button disabled type="button" title="后端尚未提供 pin API">
              Pin
            </button>
            <button disabled type="button" title="后端尚未提供 archive API">
              Archive
            </button>
          </div>
        </section>

        <section className="panelBlock">
          <div className="sectionHeader">
            <span>@Agent Menu</span>
            <small>{selectedAgents.length} selected</small>
          </div>
          <div className="agentPicker">
            {AGENT_DIRECTORY.map((agent) => {
              const selected = selectedAgentIds.includes(agent.id);
              return (
                <button
                  className={selected ? "selected" : ""}
                  key={agent.id}
                  onClick={() => toggleAgent(agent.id)}
                  style={{ "--agent-accent": agent.accent } as CSSProperties}
                  type="button"
                >
                  <span>{agent.shortName}</span>
                  <strong>{agent.name}</strong>
                  <small>{agent.role}</small>
                </button>
              );
            })}
          </div>
          <div className="mentionTray">
            {AGENT_DIRECTORY.map((agent) => (
              <button key={agent.id} onClick={() => insertMention(agent)} type="button">
                {mentionFor(agent)}
              </button>
            ))}
          </div>
        </section>

        <section className="panelBlock teamBlock">
          <div className="sectionHeader">
            <span>Team Status</span>
            <small>frontend view</small>
          </div>
          {AGENT_DIRECTORY.map((agent) => (
            <div className="teamMember" key={agent.id}>
              <span
                className="teamAvatar"
                style={{ "--agent-accent": agent.accent } as CSSProperties}
              >
                {agent.shortName}
              </span>
              <div>
                <strong>{agent.name}</strong>
                <small>{agent.role}</small>
              </div>
              <i className={agent.status}>{teamStatusLabel(agent.status)}</i>
            </div>
          ))}
        </section>
      </aside>

      <section className="chatWorkbench" aria-label="单聊与事件流">
        <header className="chatHeader">
          <div>
            <span className="eyebrow">
              {mode === "group" ? "Group draft" : "Direct chat"} / Session {session.id}
            </span>
            <h1>{session.prompt ?? prompt}</h1>
          </div>
          <div className="headerBadges">
            <span className={`socketBadge ${socketState}`}>Socket {socketState}</span>
            <span className={`runBadge ${session.status}`}>
              {isSubmitting ? "请求中" : statusLabel(session.status)}
            </span>
            <button
              className="refreshButton"
              disabled={isRefreshing}
              onClick={() => void loadSession()}
              type="button"
            >
              {isRefreshing ? "Refreshing" : "Refresh"}
            </button>
            <time>{formatTime(session.updatedAt)}</time>
          </div>
        </header>

        <section className="runStatusBar" aria-label="运行状态">
          {runSteps.map((step) => (
            <div className={`runStep ${step.state}`} key={step.label}>
              <span>{step.label}</span>
              <strong>{stepLabel(step.state)}</strong>
              <small>{step.detail}</small>
            </div>
          ))}
        </section>

        {refreshError ? (
          <div className="errorBanner" role="status">
            后端连接失败：{refreshError}
          </div>
        ) : null}

        <div className="threadPane">
          <article className="messageRow userMessage">
            <div className="messageBubble">
              <span className="messageMeta">
                User Prompt · {selectedAgents.map((agent) => mentionFor(agent)).join(" ")}
              </span>
              <p>{session.prompt ?? prompt}</p>
            </div>
          </article>

          {isRefreshing && !hasBackendSession ? (
            <div className="loadingState">
              <span />
              <strong>正在同步当前会话</strong>
              <small>如果后端不可用，将保持离线空态。</small>
            </div>
          ) : null}

          {mergedMessages.length > 0 ? (
            mergedMessages.map((message) => (
              <article
                className={`messageRow assistantMessage ${message.status}`}
                key={message.id}
              >
                <div
                  className="assistantAvatar"
                  style={{ "--agent-accent": message.agent.accent } as CSSProperties}
                >
                  {message.agent.shortName}
                </div>
                <div className="messageBubble">
                  <span className="messageMeta">
                    {message.agent.name} · {message.status} · {formatTime(message.lastTs)}
                  </span>
                  {message.text.trim() ? (
                    <p>{message.text}</p>
                  ) : (
                    <p className="emptyCopy">已收到事件，等待文本 delta 或完成输出。</p>
                  )}
                  <small>{message.events.length} linked events</small>
                </div>
              </article>
            ))
          ) : (
            <div className="emptyEvents">
              <strong>暂无 agent 回复</strong>
              <span>启动 run 后，这里会把 text_delta 合并为连续消息。</span>
            </div>
          )}

          <section className="groupThread" aria-label="群聊事件流">
            <div className="groupTitle">
              <span>Raw Event Stream</span>
              <small>真实 Socket AgentEvent；不会伪造历史事件</small>
            </div>
            {eventGroups.length > 0 ? (
              eventGroups.map((group) => (
                <article className="agentEventGroup" key={group.key}>
                  <div
                    className="eventAgentAvatar"
                    style={{ "--agent-accent": group.agent.accent } as CSSProperties}
                  >
                    {group.agent.shortName}
                  </div>
                  <div className="eventStack">
                    <div className="eventAgentHeader">
                      <strong>{group.agent.name}</strong>
                      <span>{group.agent.provider}</span>
                    </div>
                    {group.events.map((event) => (
                      <details className="eventCard" key={event.eventId}>
                        <summary>
                          <span>{event.type}</span>
                          <small>
                            seq {event.seq} · {formatTime(event.ts)}
                          </small>
                        </summary>
                        <p>{payloadSummary(event)}</p>
                        <pre>{stringifyPayload(event.payload)}</pre>
                      </details>
                    ))}
                  </div>
                </article>
              ))
            ) : (
              <div className="emptyEvents compact">
                <strong>暂无 AgentEvent</strong>
                <span>当前后端 GET 不返回事件历史；刷新不会清空已收到的 Socket 事件。</span>
              </div>
            )}
          </section>
        </div>

        <footer className="composer">
          <div className="composerTools" aria-label="当前会话模式和目标 Agent">
            <span className={`modePill ${mode}`}>{mode === "group" ? "Group" : "Direct"}</span>
            {selectedAgents.map((agent) => (
              <button key={agent.id} onClick={() => insertMention(agent)} type="button">
                {mentionFor(agent)}
              </button>
            ))}
          </div>
          <textarea
            aria-label="任务口令"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="输入任务口令，或用 @Agent 指定协作目标..."
            value={prompt}
          />
          <div className="composerFooter">
            <span>{notice}</span>
            <div className="runControls">
              <button
                className="secondary"
                disabled={!isRunning || !currentRunId || isCancelling}
                onClick={handleCancel}
                type="button"
                title={currentRunId ? "Cancel current run" : "等待 runId"}
              >
                {isCancelling ? "Cancelling" : "Cancel"}
              </button>
              <button disabled={isSubmitting} onClick={handleRun} type="button">
                {isSubmitting ? "Running" : "Run"}
              </button>
            </div>
          </div>
        </footer>
      </section>

      <aside className="inspectorPanel" aria-label="运行检查器与 artifacts">
        <section className="inspectorSection heroStatus">
          <div className="sectionHeader">
            <span>Run Inspector</span>
            <small>{hasBackendSession ? "真实会话" : "离线空态"}</small>
          </div>
          <strong>{isSubmitting ? "请求中" : statusLabel(session.status)}</strong>
          <p>{currentRunId ?? "等待 RunSessionResponse.run.id"}</p>
        </section>

        <section className="inspectorSection">
          <div className="sectionHeader">
            <span>Contract Fields</span>
            <small>{contractFields.length}</small>
          </div>
          <dl className="kvList">
            {contractFields.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="inspectorSection">
          <div className="sectionHeader">
            <span>Diff File Tree</span>
            <small>{diffFiles.length} files</small>
          </div>
          {diffFiles.length > 0 ? (
            <div className="diffTree">
              {diffFiles.map((file) => (
                <details key={file.id}>
                  <summary>
                    <span>{file.path}</span>
                    <small>
                      {file.status}
                      {file.additions !== undefined ? ` +${file.additions}` : ""}
                      {file.deletions !== undefined ? ` -${file.deletions}` : ""}
                    </small>
                  </summary>
                  <pre>{file.patch ?? "后端未返回 patch 内容。"}</pre>
                </details>
              ))}
            </div>
          ) : (
            <div className="previewEmpty">
              <strong>暂无 code_diff</strong>
              <span>收到 code_diff 事件后会在这里按文件展示。</span>
            </div>
          )}
        </section>

        <section className="inspectorSection artifactSection">
          <div className="sectionHeader">
            <span>Artifact Preview</span>
            <small>{artifacts.length} items</small>
          </div>
          {artifacts.length > 0 ? (
            <div className="artifactTabs">
              {artifacts.map((artifact) => (
                <button
                  className={selectedArtifact?.id === artifact.id ? "active" : ""}
                  key={artifact.id}
                  onClick={() => setSelectedArtifactId(artifact.id)}
                  type="button"
                >
                  <span>{artifact.kind}</span>
                  <strong>{artifact.title}</strong>
                </button>
              ))}
            </div>
          ) : null}
          <ArtifactPreviewPane artifact={selectedArtifact} />
        </section>

        <section className="inspectorSection notePanel">
          <div className="sectionHeader">
            <span>API Boundary</span>
            <small>no mock success</small>
          </div>
          <p>
            后端目前没有 session list/create/pin/archive/artifact 文件读取接口；这些控件只展示真实能力、禁用状态或事件派生内容。
          </p>
        </section>
      </aside>
    </main>
  );
}
