"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DEFAULT_WORKSPACE_PATH,
  type AgentDto,
  type AgentEvent,
  type CodeDiffPreview,
  type ConversationDto,
  type MessageDto,
  type PlanCardPayload,
  type ResultCardPayload,
  type SessionDto,
  type TeamDto,
  type TeamMemberConfig,
} from "@agenthub/shared";
import {
  connectSessionSocket,
  createAgent,
  createConversation,
  createTeam,
  getCurrentSession,
  getTeamRun,
  initialEvents,
  initialSession,
  listAgents,
  listConversations,
  listMessages,
  listTeams,
  pinMessage,
  startTeamRun,
  updateConversation,
} from "../lib/agenthub-api";
import { streamChat, type OpenAIMessage } from "../lib/openai-client";
import {
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  EditOutlined,
  EllipsisOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  InboxOutlined,
  MessageOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  RightOutlined,
  RobotOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { Button, Form, Input, Modal, Select, Tag, message as antMessage } from "antd";

type SocketState = "connecting" | "connected" | "disconnected" | "unavailable";
type FeedItem =
  | { id: string; ts: number; kind: "message"; message: MessageDto }
  | { id: string; ts: number; kind: "event"; event: AgentEvent };

const WORKSPACE_NAME = "AgentHub-Test";
const PREVIEW_URL = process.env.NEXT_PUBLIC_PREVIEW_URL ?? "http://localhost:3000";
const PUBLIC_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "public_text",
  "plan_card",
  "assignment_card",
  "result_card",
  "code_diff",
  "preview_card",
  "agent_completed",
  "agent_failed",
  "agent_cancelled",
  "done",
]);

function formatTime(value: string | number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTopicTime(value: string | number) {
  const diffMs = Math.max(0, Date.now() - new Date(value).getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))} 分`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时`;
  return `${Math.floor(diffMs / day)} 天`;
}

function agentColor(seed: string) {
  const colors = ["#2f6f73", "#315b8c", "#94612d", "#7d4a8f", "#8b3f3f", "#4d6351", "#6f5a2f"];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function initials(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "AI";
  return trimmed.slice(0, 2).toUpperCase();
}

function textPayload(payload: unknown) {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const p = payload as { text?: unknown; output?: unknown; result?: unknown; summary?: unknown; message?: unknown };
    const value = p.text ?? p.output ?? p.result ?? p.summary ?? p.message;
    if (typeof value === "string") return value;
  }
  return "";
}

function isTeamRunning(status?: string) {
  return status === "planning" || status === "executing" || status === "verifying";
}

function RichText({ text }: { text: string }) {
  const parts = text.split(/```/g);
  return (
    <div className="richText">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const code = part.replace(/^[a-zA-Z0-9_-]+\n/, "");
          return <pre key={index}>{code.trim()}</pre>;
        }
        return part
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((paragraph, pIndex) => <p key={`${index}-${pIndex}`}>{paragraph}</p>);
      })}
    </div>
  );
}

function getAgent(agents: AgentDto[], agentId?: string) {
  return agents.find((agent) => agent.id === agentId);
}

function agentMarketSummary(agent: AgentDto) {
  const summaries: Record<string, string> = {
    orchestrator: "拆解需求、分派任务、验收结果，是群聊里的主协调者。",
    "backend-agent": "负责 Express / TypeScript API、数据模型、鉴权与接口契约。",
    "frontend-agent": "负责 React / TypeScript 页面、组件状态、API 接线与交互。",
    "test-agent": "负责单元、集成、端到端测试与关键路径回归。",
    "review-agent": "负责代码审查、安全风险、可维护性和实现质量反馈。",
    claude: "适合单聊的通用 Claude Code 编码助手。",
  };
  return summaries[agent.id] ?? agent.description;
}

export default function WorkbenchPage() {
  const [session, setSession] = useState<SessionDto>(initialSession);
  const [events, setEvents] = useState<AgentEvent[]>(initialEvents);
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [quotedMessage, setQuotedMessage] = useState<MessageDto | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [activeTeamRunId, setActiveTeamRunId] = useState<string | null>(null);
  const [activeTeamRunStatus, setActiveTeamRunStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState("正在连接后端...");
  const [showNewAgentModal, setShowNewAgentModal] = useState(false);
  const [showNewTeamModal, setShowNewTeamModal] = useState(false);
  const [showAgentMarketModal, setShowAgentMarketModal] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true);
  const [activeTool, setActiveTool] = useState<"browser" | "review">("review");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [newAgentForm] = Form.useForm();
  const [newTeamForm] = Form.useForm();
  const endRef = useRef<HTMLDivElement>(null);
  const currentConversationIdRef = useRef<string | null>(null);
  const creatingDefaultConversationRef = useRef(false);

  const currentConversation = conversations.find((conv) => conv.id === currentConversationId) ?? null;
  const defaultTeam = teams.find((team) => team.id === "team-default") ?? teams[0] ?? null;
  const currentWorkspacePath = currentConversation?.workspacePath ?? DEFAULT_WORKSPACE_PATH;
  const workspaceConversations = useMemo(() => {
    return conversations.filter((conv) => conv.type === "team" && !conv.isArchived);
  }, [conversations]);
  const filteredConversations = useMemo(() => {
    const q = conversationSearch.trim().toLowerCase();
    if (!q) return workspaceConversations;
    return workspaceConversations.filter((conv) => conv.title.toLowerCase().includes(q));
  }, [conversationSearch, workspaceConversations]);

  const visibleEvents = useMemo(() => {
    return events
      .filter((event) => event.conversationId === currentConversationId)
      .filter((event) => PUBLIC_EVENT_TYPES.has(event.type));
  }, [currentConversationId, events]);

  const feedItems = useMemo<FeedItem[]>(() => {
    const messageItems: FeedItem[] = messages.map((message) => ({
      id: message.id,
      ts: new Date(message.createdAt).getTime(),
      kind: "message",
      message,
    }));
    const eventItems: FeedItem[] = visibleEvents.map((event) => ({
      id: event.eventId,
      ts: event.ts,
      kind: "event",
      event,
    }));
    return [...messageItems, ...eventItems].sort((a, b) => a.ts - b.ts);
  }, [messages, visibleEvents]);

  const diffEvents = useMemo(() => {
    return visibleEvents.filter((event) => event.type === "code_diff").slice(-4).reverse();
  }, [visibleEvents]);
  const latestDiff = diffEvents[0]?.payload as CodeDiffPreview | undefined;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [feedItems.length, streamingContent]);

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const [convRes, agentRes, teamRes, sessionRes] = await Promise.all([
        listConversations(),
        listAgents(),
        listTeams(),
        getCurrentSession(),
      ]);
      if (ignore) return;

      let conversationItems = convRes.ok ? convRes.data.items : [];
      const teamItems = teamRes.ok ? teamRes.data.items : [];
      const bootTeam = teamItems.find((team) => team.id === "team-default") ?? teamItems[0];

      if (convRes.ok && conversationItems.length === 0 && bootTeam && !creatingDefaultConversationRef.current) {
        creatingDefaultConversationRef.current = true;
        const created = await createConversation({
          title: bootTeam.name,
          type: "team",
          teamId: bootTeam.id,
          agentId: bootTeam.members.find((member) => member.role === "leader")?.agentId,
          workspacePath: DEFAULT_WORKSPACE_PATH,
        });
        creatingDefaultConversationRef.current = false;
        if (!ignore && created.ok) {
          conversationItems = [created.data];
        }
      }

      if (convRes.ok) {
        setConversations(conversationItems);
        const selectedStillExists = conversationItems.some((conv) => conv.id === currentConversationIdRef.current);
        if ((!currentConversationIdRef.current || !selectedStillExists) && conversationItems[0]) {
          currentConversationIdRef.current = conversationItems[0].id;
          setCurrentConversationId(conversationItems[0].id);
          await loadConversationMessages(conversationItems[0].id);
        }
      }
      if (agentRes.ok) setAgents(agentRes.data.items);
      if (teamRes.ok) setTeams(teamRes.data.items);
      if (sessionRes.ok) {
        if (sessionRes.data.session) setSession(sessionRes.data.session);
        setEvents((prev) => mergeEvents(prev, sessionRes.data.events));
        setNotice("后端已连接，群聊链路就绪。");
      } else {
        setNotice(`后端不可用：${sessionRes.error}`);
      }
      setIsBootstrapping(false);
    }
    void load();
    const timer = window.setInterval(load, 7000);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const disconnect = connectSessionSocket(
      currentConversationId,
      (event) => {
        setEvents((prev) => mergeEvents(prev, [event]));
        if (event.teamRunId) {
          setActiveTeamRunId(event.teamRunId);
          void refreshTeamRun(event.teamRunId);
        }
      },
      setSocketState,
    );
    return disconnect;
  }, [currentConversationId]);

  useEffect(() => {
    if (!activeTeamRunId || !isTeamRunning(activeTeamRunStatus ?? undefined)) return;
    const timer = window.setInterval(() => {
      void refreshTeamRun(activeTeamRunId);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeTeamRunId, activeTeamRunStatus]);

  async function refreshTeamRun(runId: string) {
    const result = await getTeamRun(runId);
    if (result.ok) {
      setActiveTeamRunStatus(result.data.status);
      setSession((current) => ({
        ...current,
        status: isTeamRunning(result.data.status) ? "running" : result.data.status === "succeeded" ? "succeeded" : "failed",
        updatedAt: result.data.updatedAt,
      }));
    }
  }

  async function loadConversationMessages(conversationId: string) {
    const result = await listMessages(conversationId);
    if (result.ok) {
      setMessages(result.data.items);
    } else {
      setMessages([]);
      antMessage.warning(`消息加载失败：${result.error}`);
    }
  }

  async function handleSwitchConversation(conversationId: string) {
    setCurrentConversationId(conversationId);
    setStreamingContent("");
    setQuotedMessage(null);
    setIsSubmitting(false);
    await loadConversationMessages(conversationId);
  }

  async function createWorkspaceConversation(title?: string): Promise<ConversationDto | null> {
    const team = defaultTeam;
    if (!team) {
      antMessage.error("没有可用 Team，无法创建 Agent 群聊。");
      return null;
    }

    const result = await createConversation({
      title: title?.trim() || `新 Agent 群聊 ${workspaceConversations.length + 1}`,
      type: "team",
      teamId: team.id,
      agentId: team.members.find((member) => member.role === "leader")?.agentId,
      workspacePath: DEFAULT_WORKSPACE_PATH,
    });
    if (!result.ok) {
      antMessage.error(`创建失败：${result.error}`);
      return null;
    }

    setConversations((prev) => [result.data, ...prev.filter((conv) => conv.id !== result.data.id)]);
    setCurrentConversationId(result.data.id);
    setMessages([]);
    setWorkspaceExpanded(true);
    antMessage.success("群聊已创建");
    return result.data;
  }

  async function ensureConversation(text: string): Promise<ConversationDto | null> {
    if (currentConversation) return currentConversation;
    const team = defaultTeam;
    const fallbackAgent = agents.find((agent) => agent.id === "claude") ?? agents[0];
    if (team) {
      return createWorkspaceConversation(text.slice(0, 42) || "新 Agent 群聊");
    }

    const result = await createConversation({
      title: text.slice(0, 42) || "新群聊",
      type: "direct",
      agentId: fallbackAgent?.id ?? "claude",
      workspacePath: DEFAULT_WORKSPACE_PATH,
    });
    if (!result.ok) {
      antMessage.error(`无法创建会话：${result.error}`);
      return null;
    }
    setConversations((prev) => [result.data, ...prev]);
    setCurrentConversationId(result.data.id);
    setMessages([]);
    return result.data;
  }

  async function handleSend() {
    const text = chatInput.trim();
    if (!text || isSubmitting) return;

    const conversation = await ensureConversation(text);
    if (!conversation) return;
    const quotedPrefix = quotedMessage
      ? `引用消息（${quotedMessage.role === "user" ? "用户" : quotedMessage.agentId ?? "assistant"}）：${quotedMessage.content}\n\n`
      : "";
    const promptText = `${quotedPrefix}${text}`;

    const userMessage: MessageDto = {
      id: `local-${Date.now()}`,
      conversationId: conversation.id,
      role: "user",
      content: text,
      ...(quotedMessage && { quotedMessageId: quotedMessage.id }),
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setChatInput("");
    setQuotedMessage(null);
    setIsSubmitting(true);
    setStreamingContent("");

    if (conversation.type === "team") {
      const teamId = conversation.teamId ?? defaultTeam?.id;
      if (!teamId) {
        antMessage.error("没有可用 Team，请先创建群聊团队。");
        setIsSubmitting(false);
        return;
      }
      const result = await startTeamRun(teamId, {
        prompt: promptText,
        conversationId: conversation.id,
        repositoryPath: conversation.workspacePath ?? DEFAULT_WORKSPACE_PATH,
      });
      if (result.ok) {
        setActiveTeamRunId(result.data.id);
        setActiveTeamRunStatus(result.data.status);
        setNotice("Orchestrator 已接管，正在分派 Claude Code 实例。");
      } else {
        antMessage.error(`启动失败：${result.error}`);
        setNotice(`团队启动失败：${result.error}`);
      }
      setIsSubmitting(false);
      return;
    }

    const model = conversation.agentId ?? agents[0]?.id ?? "claude";
    const history: OpenAIMessage[] = [
      ...messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role as OpenAIMessage["role"], content: message.content })),
      { role: "user", content: promptText },
    ];
    let fullContent = "";
    try {
      for await (const chunk of streamChat(history, model, conversation.id)) {
        fullContent += chunk;
        setStreamingContent(fullContent);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `local-assistant-${Date.now()}`,
          conversationId: conversation.id,
          role: "assistant",
          content: fullContent,
          agentId: model,
          createdAt: new Date().toISOString(),
        },
      ]);
      setStreamingContent("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      antMessage.error(`流式请求失败：${message}`);
      setMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          conversationId: conversation.id,
          role: "assistant",
          content: `请求失败：${message}`,
          agentId: model,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCreateAgent() {
    try {
      const values = await newAgentForm.validateFields();
      const result = await createAgent({
        name: values.name,
        description: values.description ?? "",
        provider: values.provider ?? "local-cli",
        role: values.role ?? "assistant",
        tags: String(values.tags ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        systemPrompt: values.systemPrompt ?? "",
      });
      if (result.ok) {
        setAgents((prev) => [...prev, result.data]);
        setShowNewAgentModal(false);
        newAgentForm.resetFields();
        antMessage.success("Agent 已创建");
      } else {
        antMessage.error(`创建失败：${result.error}`);
      }
    } catch {
      // form validation
    }
  }

  async function handleCreateTeam() {
    try {
      const values = await newTeamForm.validateFields();
      const members: TeamMemberConfig[] = [
        { agentId: values.leaderAgentId, role: "leader" },
        ...(values.workerAgentIds as string[])
          .filter((agentId) => agentId !== values.leaderAgentId)
          .map((agentId) => ({ agentId, role: "worker" as const })),
      ];
      const result = await createTeam({
        name: values.name,
        description: values.description ?? "",
        members,
      });
      if (result.ok) {
        setTeams((prev) => [...prev, result.data]);
        setShowNewTeamModal(false);
        newTeamForm.resetFields();
        antMessage.success("Team 已创建");
      } else {
        antMessage.error(`创建失败：${result.error}`);
      }
    } catch {
      // form validation
    }
  }

  async function handleToggleConversationPin(conversation: ConversationDto) {
    const result = await updateConversation(conversation.id, { isPinned: !conversation.isPinned });
    if (!result.ok) {
      antMessage.error(`更新失败：${result.error}`);
      return;
    }
    setConversations((prev) =>
      prev
        .map((item) => (item.id === result.data.id ? result.data : item))
        .sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        }),
    );
  }

  async function handleArchiveConversation(conversation: ConversationDto) {
    const result = await updateConversation(conversation.id, { isArchived: true });
    if (!result.ok) {
      antMessage.error(`归档失败：${result.error}`);
      return;
    }
    setConversations((prev) => prev.map((item) => (item.id === result.data.id ? result.data : item)));
    if (currentConversationId === conversation.id) {
      const next = conversations.find((item) => item.id !== conversation.id && item.type === "team" && !item.isArchived);
      setCurrentConversationId(next?.id ?? null);
      setMessages([]);
    }
  }

  async function handleCopyMessage(content: string) {
    await navigator.clipboard.writeText(content);
    antMessage.success("已复制");
  }

  async function handleToggleMessagePin(message: MessageDto) {
    const result = await pinMessage(message.conversationId, message.id, { pinned: !message.pinned });
    if (!result.ok) {
      antMessage.error(`Pin 失败：${result.error}`);
      return;
    }
    setMessages((prev) => prev.map((item) => (item.id === result.data.id ? result.data : item)));
  }

  const activeTeam = currentConversation?.teamId
    ? teams.find((team) => team.id === currentConversation.teamId) ?? defaultTeam
    : defaultTeam;

  return (
    <main className="workspaceShell">
      <aside className="sessionColumn">
        <nav className="sidebarMenu" aria-label="主菜单">
          <button
            className="sidebarMenuItem"
            type="button"
            onClick={() => void createWorkspaceConversation()}
          >
            <MessageOutlined />
            <span>新项目</span>
          </button>
          <button
            className="sidebarMenuItem"
            type="button"
            onClick={() => document.getElementById("conversation-search")?.focus()}
          >
            <SearchOutlined />
            <span>搜索</span>
          </button>
          <button className="sidebarMenuItem" type="button" onClick={() => setShowAgentMarketModal(true)}>
            <RobotOutlined />
            <span>Agent 市场</span>
          </button>
        </nav>

        <section className="panelBlock chatGroupBlock">
          <div className="sectionHeader">
            <span>群聊</span>
            <span className={`sideSocket ${socketState}`} title={socketState} />
          </div>
          <div className="workspaceTopic">
            <div className="workspaceProjectRow">
              <button
                className="workspaceProjectButton"
                type="button"
                onClick={() => setWorkspaceExpanded((expanded) => !expanded)}
                title={workspaceExpanded ? "收起群聊话题" : "展开群聊话题"}
              >
                {workspaceExpanded ? <DownOutlined /> : <RightOutlined />}
                <FolderOpenOutlined />
                <span>{WORKSPACE_NAME}</span>
              </button>
              <button
                className="workspaceIconButton"
                type="button"
                onClick={() => setShowAgentMarketModal(true)}
                title="查看工作区 Agent"
              >
                <EllipsisOutlined />
              </button>
              <button
                className="workspaceIconButton"
                type="button"
                onClick={() => void createWorkspaceConversation()}
                title={`在 ${WORKSPACE_NAME} 中开始新对话`}
              >
                <EditOutlined />
              </button>
            </div>

            {workspaceExpanded && (
              <>
                <Input
                  id="conversation-search"
                  prefix={<SearchOutlined />}
                  size="small"
                  value={conversationSearch}
                  onChange={(event) => setConversationSearch(event.target.value)}
                  placeholder="搜索群聊"
                  allowClear
                />
                <div className="sessionList">
                  {filteredConversations.length === 0 ? (
                    <div className="emptyMini">
                      {isBootstrapping
                        ? "正在加载群聊..."
                        : workspaceConversations.length === 0
                          ? "还没有群聊，点击新项目创建。"
                          : "没有匹配的群聊。"}
                    </div>
                  ) : (
                    filteredConversations.map((conv) => (
                      <button
                        className={`sessionCard ${conv.id === currentConversationId ? "active" : ""}`}
                        type="button"
                        key={conv.id}
                        onClick={() => void handleSwitchConversation(conv.id)}
                      >
                        <span className="sessionTitle">
                          {conv.isPinned && <PushpinFilled />}
                          {conv.title}
                        </span>
                        <small>{conv.messageCount} 条 · {formatTopicTime(conv.updatedAt)}</small>
                        <span className="sessionActions">
                          <span
                            role="button"
                            tabIndex={0}
                            className="miniActionButton"
                            title={conv.isPinned ? "取消置顶" : "置顶会话"}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleToggleConversationPin(conv);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.stopPropagation();
                                void handleToggleConversationPin(conv);
                              }
                            }}
                          >
                            {conv.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            className="miniActionButton"
                            title="归档会话"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleArchiveConversation(conv);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.stopPropagation();
                                void handleArchiveConversation(conv);
                              }
                            }}
                          >
                            <InboxOutlined />
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </section>

        <button className="settingsItem" type="button">
          <SettingOutlined />
          <span>设置</span>
        </button>
      </aside>

      <section className="chatWorkbench">
        <div className="threadPane">
          {feedItems.map((item) =>
            item.kind === "message" ? (
              <MessageBubble
                key={item.id}
                message={item.message}
                agents={agents}
                onCopy={handleCopyMessage}
                onQuote={setQuotedMessage}
                onTogglePin={handleToggleMessagePin}
              />
            ) : (
              <EventBubble key={item.id} event={item.event} agents={agents} />
            ),
          )}

          {streamingContent && (
            <article className="messageRow assistantMessage running">
              <Avatar label="AI" color="#315b8c" />
              <div className="messageBubble">
                <span className="messageMeta">Assistant · 流式输出中</span>
                <RichText text={streamingContent} />
              </div>
            </article>
          )}
          <div ref={endRef} />
        </div>

        <footer className="composer">
          {quotedMessage && (
            <div className="quotePreview">
              <span>引用：{quotedMessage.content.slice(0, 120)}</span>
              <button type="button" onClick={() => setQuotedMessage(null)}>取消</button>
            </div>
          )}
          <textarea
            aria-label="输入消息"
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder="描述需求，Orchestrator 会拆解并分派给群聊 Agent"
            disabled={isSubmitting}
          />
          <div className="composerFooter">
            <span>{notice}</span>
            <Button type="primary" icon={<SendOutlined />} loading={isSubmitting} disabled={!chatInput.trim()} onClick={() => void handleSend()}>
              发送
            </Button>
          </div>
        </footer>
      </section>

      <aside className="inspectorPanel">
        <section className="inspectorSection toolDockPanel">
          <div className="sectionHeader">
            <span>工具</span>
            <small>{currentConversation?.title ?? "当前群聊"}</small>
          </div>
          <div className="workspacePathLine">
            <FolderOpenOutlined />
            <code>{currentWorkspacePath}</code>
          </div>
          <div className="toolCards">
            <button
              className={`toolCard ${activeTool === "browser" ? "active" : ""}`}
              type="button"
              onClick={() => {
                setActiveTool("browser");
                window.open(PREVIEW_URL, "_blank", "noopener,noreferrer");
              }}
            >
              <GlobalOutlined />
              <strong>浏览器</strong>
              <span>打开网站</span>
            </button>
            <button
              className={`toolCard ${activeTool === "review" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTool("review")}
            >
              <CodeOutlined />
              <strong>审查</strong>
              <span>查看代码更改</span>
            </button>
          </div>
          <ToolDetail
            activeTool={activeTool}
            latestDiff={latestDiff}
            previewUrl={PREVIEW_URL}
            workspacePath={currentWorkspacePath}
          />
        </section>

        <section className="inspectorSection acceptancePanel">
          <div className="sectionHeader">
            <span>验收任务</span>
            <small>建议输入</small>
          </div>
          <p>帮我写一份前后端分离的 todolist, 要求能实现简单的注册 / 登录，添加 todo, 给 todo 打勾，删除 todo。</p>
          <Button
            icon={<CopyOutlined />}
            onClick={() => void handleCopyMessage("帮我写一份前后端分离的 todolist, 要求能实现简单的注册 / 登录，添加 todo, 给 todo 打勾，删除 todo。")}
          >
            复制任务
          </Button>
        </section>

        <section className="inspectorSection agentRosterPanel">
          <div className="sectionHeader">
            <span>当前群聊 Agent</span>
            <small>{activeTeam?.members.length ?? 0} 名</small>
          </div>
          {activeTeam ? (
            <div className="agentRosterList">
              {activeTeam.members.map((member) => {
                const agent = getAgent(agents, member.agentId);
                const agentName = agent?.name ?? member.agentId;
                return (
                  <article className="rosterAgentCard" key={`${activeTeam.id}-${member.agentId}`}>
                    <span className="agentAvatar" style={{ "--agent-color": agentColor(member.agentId) } as CSSProperties}>
                      {initials(agentName)}
                    </span>
                    <div>
                      <strong>{agentName}</strong>
                      <small>{member.role === "leader" ? "Orchestrator / Leader" : agent?.role ?? "worker"}</small>
                    </div>
                    <Tag color={member.role === "leader" ? "blue" : "default"}>
                      {member.role === "leader" ? "主控" : "成员"}
                    </Tag>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="emptyMini">当前还没有群聊成员。</div>
          )}
        </section>
      </aside>

      <Modal
        title="Agent 市场"
        open={showAgentMarketModal}
        onCancel={() => setShowAgentMarketModal(false)}
        footer={null}
        width={820}
        destroyOnHidden
      >
        <div className="agentMarket">
          <div className="marketIntro">
            <strong>预设 Agent</strong>
            <span>这些 Agent 已接入当前平台，可直接用于群聊编排或单聊。</span>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setShowAgentMarketModal(false);
                setShowNewAgentModal(true);
              }}
            >
              自定义 Agent
            </Button>
          </div>
          <div className="marketGrid">
            {agents.map((agent) => (
              <article className="marketAgentCard" key={agent.id}>
                <span className="agentAvatar large" style={{ "--agent-color": agentColor(agent.id) } as CSSProperties}>
                  {initials(agent.name)}
                </span>
                <div>
                  <strong>{agent.name}</strong>
                  <small>{agent.provider} · {agent.role}</small>
                  <p>{agentMarketSummary(agent)}</p>
                  <div className="marketTags">
                    {agent.tags.slice(0, 4).map((tag) => <Tag key={tag}>{tag}</Tag>)}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </Modal>

      <Modal
        title="新建 Agent"
        open={showNewAgentModal}
        onOk={handleCreateAgent}
        onCancel={() => {
          setShowNewAgentModal(false);
          newAgentForm.resetFields();
        }}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={newAgentForm} layout="vertical" initialValues={{ provider: "local-cli" }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="Frontend Agent" />
          </Form.Item>
          <Form.Item name="description" label="描述"><Input placeholder="负责 React UI 和 API 接线" /></Form.Item>
          <Form.Item name="provider" label="Provider"><Select><Select.Option value="local-cli">local-cli</Select.Option></Select></Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: "请输入角色" }]}>
            <Input placeholder="frontend-developer" />
          </Form.Item>
          <Form.Item name="tags" label="标签"><Input placeholder="frontend, react, ui" /></Form.Item>
          <Form.Item name="systemPrompt" label="System Prompt"><Input.TextArea rows={5} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新建 Team"
        open={showNewTeamModal}
        onOk={handleCreateTeam}
        onCancel={() => {
          setShowNewTeamModal(false);
          newTeamForm.resetFields();
        }}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={newTeamForm} layout="vertical">
          <Form.Item name="name" label="Team 名称" rules={[{ required: true, message: "请输入 Team 名称" }]}>
            <Input placeholder="Full-Stack Team" />
          </Form.Item>
          <Form.Item name="description" label="描述"><Input placeholder="默认全栈协作团队" /></Form.Item>
          <Form.Item name="leaderAgentId" label="Leader" rules={[{ required: true, message: "请选择 Leader" }]}>
            <Select placeholder="选择 Orchestrator">
              {agents.map((agent) => <Select.Option key={agent.id} value={agent.id}>{agent.name}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item
            name="workerAgentIds"
            label="Workers"
            rules={[{ required: true, type: "array", min: 1, message: "至少选择一个 Worker" }]}
          >
            <Select mode="multiple" placeholder="选择 Backend / Frontend Agent">
              {agents.map((agent) => <Select.Option key={agent.id} value={agent.id}>{agent.name}</Select.Option>)}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </main>
  );
}

function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]) {
  const map = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) {
    map.set(event.eventId, event);
  }
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

function Avatar({ label, color }: { label: string; color: string }) {
  return <span className="assistantAvatar" style={{ "--agent-color": color } as CSSProperties}>{label}</span>;
}

function ToolDetail({
  activeTool,
  latestDiff,
  previewUrl,
  workspacePath,
}: {
  activeTool: "browser" | "review";
  latestDiff?: CodeDiffPreview;
  previewUrl: string;
  workspacePath: string;
}) {
  if (activeTool === "browser") {
    return (
      <div className="toolDetail">
        <div className="toolDetailHeader">
          <strong>浏览器</strong>
          <button type="button" onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}>
            打开
          </button>
        </div>
        <code>{previewUrl}</code>
        <small>使用当前群聊工作区预览：{workspacePath}</small>
      </div>
    );
  }

  const changedFiles = latestDiff?.changedFiles ?? [];
  return (
    <div className="toolDetail">
      <div className="toolDetailHeader">
        <strong>审查</strong>
        <span>{changedFiles.length} 个文件</span>
      </div>
      {latestDiff && changedFiles.length > 0 ? (
        <>
          {latestDiff.stat && <pre>{latestDiff.stat}</pre>}
          <div className="reviewFiles">
            {changedFiles.slice(0, 10).map((file) => <Tag key={file}>{file}</Tag>)}
          </div>
        </>
      ) : (
        <div className="emptyMini">当前群聊还没有代码更改。</div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  agents,
  onCopy,
  onQuote,
  onTogglePin,
}: {
  message: MessageDto;
  agents: AgentDto[];
  onCopy: (content: string) => void | Promise<void>;
  onQuote: (message: MessageDto) => void;
  onTogglePin: (message: MessageDto) => void | Promise<void>;
}) {
  const isUser = message.role === "user";
  const agent = getAgent(agents, message.agentId);
  const name = isUser ? "你" : agent?.name ?? "Assistant";
  const color = isUser ? "#315b8c" : agentColor(agent?.id ?? "assistant");
  return (
    <article className={`messageRow ${isUser ? "userMessage" : "assistantMessage"}`}>
      {!isUser && <Avatar label={initials(name)} color={color} />}
      <div className="messageBubble">
        <div className="messageTopLine">
          <span className="messageMeta">
            {name} · {formatTime(message.createdAt)}
            {message.pinned && <em>已 Pin</em>}
          </span>
          <span className="messageActions">
            <button type="button" title="复制消息" onClick={() => void onCopy(message.content)}>
              <CopyOutlined />
            </button>
            <button type="button" title="引用回复" onClick={() => onQuote(message)}>
              <MessageOutlined />
            </button>
            <button type="button" title={message.pinned ? "取消 Pin" : "Pin 为上下文"} onClick={() => void onTogglePin(message)}>
              {message.pinned ? <PushpinFilled /> : <PushpinOutlined />}
            </button>
          </span>
        </div>
        {message.quotedMessageId && <div className="quotedLine">引用消息：{message.quotedMessageId}</div>}
        <RichText text={message.content} />
      </div>
      {isUser && <Avatar label="你" color={color} />}
    </article>
  );
}

function EventBubble({ event, agents }: { event: AgentEvent; agents: AgentDto[] }) {
  const agent = getAgent(agents, event.agentId);
  const name = agent?.name ?? event.agentId;
  const color = agentColor(event.agentId);
  const failed = event.type === "agent_failed" || event.type === "agent_cancelled";

  return (
    <article className={`messageRow assistantMessage ${failed ? "failed" : ""}`}>
      <Avatar label={initials(name)} color={color} />
      <div className={`messageBubble eventBubble ${event.type}`}>
        <span className="messageMeta">{name} · {formatTime(event.ts)}</span>
        <EventContent event={event} agentName={name} />
      </div>
    </article>
  );
}

function EventContent({ event, agentName }: { event: AgentEvent; agentName: string }) {
  if (event.type === "public_text") {
    return <RichText text={textPayload(event.payload)} />;
  }

  if (event.type === "plan_card") {
    const payload = event.payload as PlanCardPayload;
    return (
      <div className="artifactCard planCard">
        <strong>任务计划</strong>
        <p>{payload.plan.summary}</p>
        <div className="taskList">
          {payload.plan.tasks.map((task) => (
            <div key={`${task.agentId}-${task.task}`}>
              <Tag color="blue">{task.agentId}</Tag>
              <span>{task.task}</span>
              {task.dependsOn.length > 0 && <small>依赖：{task.dependsOn.join(", ")}</small>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (event.type === "assignment_card") {
    const payload = event.payload as { agentId: string; task: string; dependsOn: string[] };
    return (
      <div className="artifactCard assignmentCard">
        <strong>任务分派给 {payload.agentId}</strong>
        <p>{payload.task}</p>
        {payload.dependsOn.length > 0 && <small>依赖：{payload.dependsOn.join(", ")}</small>}
      </div>
    );
  }

  if (event.type === "result_card") {
    const payload = event.payload as ResultCardPayload;
    return (
      <div className={`artifactCard resultCard ${payload.status}`}>
        <strong>{payload.title || `${agentName} 结果`}</strong>
        <RichText text={payload.summary} />
      </div>
    );
  }

  if (event.type === "code_diff") {
    return <DiffCard diff={event.payload as CodeDiffPreview} />;
  }

  if (event.type === "preview_card") {
    return (
      <div className="artifactCard previewCard">
        <strong>预览卡片</strong>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </div>
    );
  }

  if (event.type === "agent_failed" || event.type === "agent_cancelled") {
    return (
      <div className="artifactCard resultCard failed">
        <strong>{event.type === "agent_cancelled" ? "任务已取消" : "任务失败"}</strong>
        <RichText text={textPayload(event.payload) || JSON.stringify(event.payload, null, 2)} />
      </div>
    );
  }

  return <RichText text={textPayload(event.payload) || event.type} />;
}

function DiffCard({ diff }: { diff: CodeDiffPreview }) {
  return (
    <details className="artifactCard diffCard" open>
      <summary>
        <strong>已编辑文件</strong>
        <span>{diff.changedFiles.length} 个文件</span>
      </summary>
      <div className="diffFiles">
        {diff.changedFiles.slice(0, 8).map((file) => <Tag key={file}>{file}</Tag>)}
      </div>
      {diff.stat && <pre>{diff.stat}</pre>}
      {diff.patch && <pre className="patchBlock">{diff.patch}{diff.truncated ? "\n... diff 已截断" : ""}</pre>}
    </details>
  );
}
