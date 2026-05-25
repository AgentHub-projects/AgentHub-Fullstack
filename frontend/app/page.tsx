"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  AgentDto,
  AgentEvent,
  ConversationDto,
  ConversationType,
  MessageDto,
  SessionDto,
  TeamDto,
  TeamMemberConfig,
  TeamMemberRole,
  TeamRunDto,
} from "@agenthub/shared";
import {
  connectSessionSocket,
  getCurrentSession,
  initialEvents,
  initialSession,
  listConversations,
  createConversation,
  listMessages,
  listAgents,
  createAgent,
  listTeams,
  createTeam,
  startTeamRun,
  getTeamRun,
} from "../lib/agenthub-api";
import { streamChat, type OpenAIMessage } from "../lib/openai-client";

// antd imports
import {
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  message as antMessage,
} from "antd";
import { PlusOutlined, SearchOutlined } from "@ant-design/icons";

// ---- Types ----

type SocketState = "connecting" | "connected" | "disconnected" | "unavailable";
type TeamStatus = "view" | "active" | "waiting" | "done" | "error";

type TeamMember = {
  id: string;
  name: string;
  shortName: string;
  role: string;
  provider: string;
  status: TeamStatus;
  accent: string;
};

type TeamMemberWithStatus = TeamDto["members"][number] & {
  status: TeamStatus;
};

// ---- Constants ----

const DEFAULT_PROMPT = "帮我写一个前后端分离的架构的todolist系统。";

const TEAM_MEMBER_COLORS: Record<string, string> = {
  orchestrator: "#5f6f52",
  frontend: "#2563eb",
  backend: "#0f766e",
  review: "#a16207",
  test: "#7c3aed",
  merge: "#475569",
};

const defaultTeamMembers: TeamMember[] = [
  {
    id: "orchestrator-agent",
    name: "Orchestrator",
    shortName: "OR",
    role: "任务拆解与阶段汇总",
    provider: "Frontend status view",
    status: "view",
    accent: "#5f6f52",
  },
  {
    id: "frontend-agent",
    name: "Frontend",
    shortName: "FE",
    role: "界面实现与 API 接线",
    provider: "Frontend status view",
    status: "active",
    accent: "#2563eb",
  },
  {
    id: "backend-agent",
    name: "Backend",
    shortName: "BE",
    role: "会话 API / Socket",
    provider: "Frontend status view",
    status: "waiting",
    accent: "#0f766e",
  },
  {
    id: "review-agent",
    name: "Review",
    shortName: "RV",
    role: "契约与回归审查",
    provider: "Frontend status view",
    status: "waiting",
    accent: "#a16207",
  },
  {
    id: "test-agent",
    name: "Test",
    shortName: "TS",
    role: "typecheck / integration",
    provider: "Frontend status view",
    status: "waiting",
    accent: "#7c3aed",
  },
  {
    id: "merge-agent",
    name: "Merge",
    shortName: "MG",
    role: "提交集成状态",
    provider: "Frontend status view",
    status: "waiting",
    accent: "#475569",
  },
];

// ---- Helpers ----

function formatTime(value: string | number) {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
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

function stringifyPayload(payload: unknown) {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload, null, 2);
}

function payloadSummary(event: AgentEvent) {
  if (typeof event.payload === "string") return event.payload;
  if (event.payload && typeof event.payload === "object") {
    const p = event.payload as Record<string, unknown>;
    const msg = p.message ?? p.title ?? p.status;
    if (typeof msg === "string") return msg;
  }
  return event.type.replace(/_/g, " ");
}

function getAgentMeta(agentId: string) {
  return (
    defaultTeamMembers.find((a) => a.id === agentId) ?? {
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

function agentAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    "#2563eb", "#0f766e", "#a16207", "#7c3aed", "#b42318",
    "#475569", "#0891b2", "#be185d", "#4f46e5", "#15803d",
  ];
  return colors[Math.abs(hash) % colors.length];
}

function agentInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// ---- Main Page ----

export default function WorkbenchPage() {
  // Session / Events (backward compat)
  const [session, setSession] = useState<SessionDto>(initialSession);
  const [events, setEvents] = useState<AgentEvent[]>(initialEvents);
  const [socketState, setSocketState] = useState<SocketState>("connecting");

  // Conversations
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");

  // Chat
  const [chatMessages, setChatMessages] = useState<OpenAIMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const chatViewRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Agents & Teams
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [teams, setTeams] = useState<TeamDto[]>([]);

  // Team run state
  const [activeTeamRun, setActiveTeamRun] = useState<TeamRunDto | null>(null);
  const [teamMembersWithStatus, setTeamMembersWithStatus] = useState<TeamMemberWithStatus[]>([]);

  // Modals
  const [showNewConvModal, setShowNewConvModal] = useState(false);
  const [showNewAgentModal, setShowNewAgentModal] = useState(false);
  const [showNewTeamModal, setShowNewTeamModal] = useState(false);

  // Modal forms
  const [newConvForm] = Form.useForm();
  const [newAgentForm] = Form.useForm();
  const [newTeamForm] = Form.useForm();

  // Notice bar
  const [notice, setNotice] = useState("");

  // ---- Computed ----

  const currentConversation = conversations.find((c) => c.id === currentConversationId);

  const filteredConversations = useMemo(() => {
    if (!conversationSearch.trim()) return conversations;
    const q = conversationSearch.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, conversationSearch]);

  const eventGroups = useMemo(() => {
    return events.reduce<
      Array<{ agent: TeamMember; events: AgentEvent[]; key: string }>
    >((groups, event) => {
      const agent = getAgentMeta(event.agentId);
      const last = groups.at(-1);
      if (last?.agent.id === agent.id) {
        last.events.push(event);
        return groups;
      }
      groups.push({ agent, events: [event], key: `${agent.id}-${event.eventId}` });
      return groups;
    }, []);
  }, [events]);

  // ---- Auto-scroll ----

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, streamingContent]);

  // ---- Data loading ----

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

      if (convRes.ok) {
        setConversations(convRes.data.items);
      }
      if (agentRes.ok) {
        setAgents(agentRes.data.items);
      }
      if (teamRes.ok) {
        setTeams(teamRes.data.items);
      }
      if (sessionRes.ok) {
        if (sessionRes.data.session) {
          setSession(sessionRes.data.session);
        }
        setEvents(sessionRes.data.events);
        setNotice("已从后端同步数据。");
      } else {
        setNotice("后端未连接，部分功能不可用。");
      }
    }

    void load();
    const timer = window.setInterval(load, 6000);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, []);

  // Socket connection
  useEffect(() => {
    const disconnect = connectSessionSocket(
      currentConversationId,
      (event) => {
        setEvents((current) => {
          if (current.some((item) => item.eventId === event.eventId)) return current;
          return [...current, event].sort((a, b) => a.seq - b.seq);
        });
        // If team event, refresh team run
        if (event.teamRunId && activeTeamRun?.id === event.teamRunId) {
          getTeamRun(event.teamRunId!).then((r) => {
            if (r.ok) setActiveTeamRun(r.data);
          });
        }
      },
      (state) => setSocketState(state),
    );
    return disconnect;
  }, [currentConversationId, activeTeamRun?.id]);

  // Poll team run status
  useEffect(() => {
    if (!activeTeamRun || activeTeamRun.status === "succeeded" || activeTeamRun.status === "failed") return;
    const timer = window.setInterval(async () => {
      const result = await getTeamRun(activeTeamRun.id);
      if (result.ok) setActiveTeamRun(result.data);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeTeamRun?.id, activeTeamRun?.status]);

  // ---- Conversation handlers ----

  async function handleNewConversation() {
    try {
      const values = await newConvForm.validateFields();
      const type: ConversationType = values.type ?? "direct";
      const body: { title: string; agentId?: string; type: ConversationType; teamId?: string } = {
        title: values.title,
        type,
      };
      if (type === "direct" && values.agentId) {
        body.agentId = values.agentId;
      }
      if (type === "team" && values.teamId) {
        body.teamId = values.teamId;
      }

      const result = await createConversation(body);
      if (result.ok) {
        const newConv = result.data;
        setConversations((prev) => [newConv, ...prev]);
        setCurrentConversationId(newConv.id);
        setChatMessages([]);
        setShowNewConvModal(false);
        newConvForm.resetFields();
        antMessage.success("会话已创建");
      } else {
        antMessage.error(`创建失败: ${result.error}`);
      }
    } catch {
      // validation failed
    }
  }

  async function handleSwitchConversation(convId: string) {
    setCurrentConversationId(convId);
    setStreamingContent("");
    setIsStreaming(false);

    // Load messages for chat mode
    const conv = conversations.find((c) => c.id === convId);
    if (conv?.type === "direct") {
      const result = await listMessages(convId);
      if (result.ok) {
        const msgs: OpenAIMessage[] = result.data.items.map((m: MessageDto) => ({
          role: m.role as OpenAIMessage["role"],
          content: m.content,
        }));
        setChatMessages(msgs);
      } else {
        setChatMessages([]);
      }
    } else {
      // Team conversations: clear chat messages, use orchestration view
      setChatMessages([]);
    }
  }

  // ---- Chat send ----

  async function handleSend() {
    const text = chatInput.trim();
    if (!text || isStreaming) return;

    // Create conversation if none selected
    let convId = currentConversationId;
    if (!convId) {
      const createResult = await createConversation({
        title: text.slice(0, 50),
        type: "direct",
        agentId: agents.find((a) => a.id === "claude")?.id ?? agents[0]?.id ?? "claude",
      });
      if (createResult.ok) {
        convId = createResult.data.id;
        setConversations((prev) => [createResult.data, ...prev]);
        setCurrentConversationId(convId);
        setChatMessages([]);
      } else {
        antMessage.error(`无法创建会话: ${createResult.error}`);
        return;
      }
    }

    // Save user message locally (backend persists it)
    const userMsg: OpenAIMessage = { role: "user", content: text };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput("");
    setIsStreaming(true);
    setStreamingContent("");

    // Get agent model
    const conv = conversations.find((c) => c.id === convId);
    const model = conv?.agentId ?? agents[0]?.id ?? "claude";

    // Stream assistant response
    let fullContent = "";
    try {
      const messages = [...chatMessages, userMsg];
      for await (const chunk of streamChat(messages, model, convId!)) {
        fullContent += chunk;
        setStreamingContent(fullContent);
      }
      // Append final assistant message
      setChatMessages((prev) => [...prev, { role: "assistant", content: fullContent }]);
      setStreamingContent("");
    } catch (err) {
      antMessage.error(`流式请求失败: ${err instanceof Error ? err.message : String(err)}`);
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: `[错误] ${err instanceof Error ? err.message : String(err)}` },
      ]);
      setStreamingContent("");
    } finally {
      setIsStreaming(false);
    }
  }

  // ---- Agent creation ----

  async function handleCreateAgent() {
    try {
      const values = await newAgentForm.validateFields();
      const tags: string[] = values.tags
        ? values.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
        : [];
      const body = {
        name: values.name,
        description: values.description ?? "",
        provider: values.provider ?? "local-cli",
        role: values.role ?? "",
        tags,
        systemPrompt: values.systemPrompt ?? "",
      };
      const result = await createAgent(body);
      if (result.ok) {
        setAgents((prev) => [...prev, result.data]);
        setShowNewAgentModal(false);
        newAgentForm.resetFields();
        antMessage.success("Agent 已创建");
      } else {
        antMessage.error(`创建失败: ${result.error}`);
      }
    } catch {
      // validation failed
    }
  }

  // ---- Team creation ----

  async function handleCreateTeam() {
    try {
      const values = await newTeamForm.validateFields();
      const members: TeamMemberConfig[] = values.members ?? [];
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
        antMessage.error(`创建失败: ${result.error}`);
      }
    } catch {
      // validation failed
    }
  }

  // ---- Team run ----

  async function handleStartTeamRun(teamId: string) {
    const text = chatInput.trim();
    if (!text) return;

    let convId = currentConversationId;
    if (!convId) {
      const team = teams.find((t) => t.id === teamId);
      const createResult = await createConversation({
        title: text.slice(0, 50),
        type: "team",
        teamId,
        agentId: team?.members.find((m) => m.role === "leader")?.agentId,
      });
      if (createResult.ok) {
        convId = createResult.data.id;
        setConversations((prev) => [createResult.data, ...prev]);
        setCurrentConversationId(convId);
        setChatMessages([]);
      } else {
        antMessage.error(`无法创建会话: ${createResult.error}`);
        return;
      }
    }

    setChatInput("");
    setNotice("启动团队编排运行...");

    const result = await startTeamRun(teamId, { prompt: text, conversationId: convId! });
    if (result.ok) {
      setActiveTeamRun(result.data);
      setNotice("团队编排已启动");
      antMessage.success("团队任务已分发");
    } else {
      setNotice(`团队启动失败: ${result.error}`);
      antMessage.error(`启动失败: ${result.error}`);
    }
  }

  // ---- Render ----

  const convType = Form.useWatch("type", newConvForm) ?? "direct";

  return (
    <main className="workspaceShell">
      {/* ---- Icon Rail ---- */}
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

      {/* ---- Sidebar ---- */}
      <aside className="sessionColumn" aria-label="会话与 Agent">
        <section className="columnTop">
          <div>
            <strong>AgentHub</strong>
            <span>Multi-agent workbench</span>
          </div>
          <span className={`statusPill ${session.status}`}>
            {statusLabel(session.status)}
          </span>
        </section>

        {/* Conversations */}
        <section className="panelBlock">
          <div className="sectionHeader">
            <span>Conversations</span>
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setShowNewConvModal(true)}
              title="新建会话"
            />
          </div>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索会话..."
            size="small"
            value={conversationSearch}
            onChange={(e) => setConversationSearch(e.target.value)}
            allowClear
            style={{ marginBottom: 4 }}
          />
          {filteredConversations.length === 0 ? (
            <div className="emptyEvents" style={{ padding: "8px 0" }}>
              <span>暂无会话，点击 + 创建</span>
            </div>
          ) : (
            filteredConversations.map((conv) => (
              <button
                key={conv.id}
                className={`sessionCard ${conv.id === currentConversationId ? "active" : ""}`}
                type="button"
                onClick={() => handleSwitchConversation(conv.id)}
              >
                <span>{conv.title}</span>
                <small>
                  {conv.type === "team" ? "Team" : "Direct"} · {conv.messageCount} msgs
                </small>
              </button>
            ))
          )}
        </section>

        {/* Agents */}
        <section className="panelBlock">
          <div className="sectionHeader">
            <span>Agents</span>
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setShowNewAgentModal(true)}
              title="新建 Agent"
            />
          </div>
          {agents.length === 0 ? (
            <div className="agentCard">
              <span className="agentAvatar">CC</span>
              <div>
                <strong>Claude Code</strong>
                <small>默认 Agent</small>
              </div>
            </div>
          ) : (
            agents.map((agent) => (
              <div className="agentCard" key={agent.id}>
                <span
                  className="agentAvatar"
                  style={{ background: agentAvatarColor(agent.name) }}
                >
                  {agentInitials(agent.name)}
                </span>
                <div>
                  <strong>{agent.name}</strong>
                  <small>{agent.role || agent.description}</small>
                  {agent.tags && agent.tags.length > 0 && (
                    <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {agent.tags.slice(0, 3).map((tag) => (
                        <Tag key={tag} color="blue" style={{ fontSize: 10, margin: 0 }}>
                          {tag}
                        </Tag>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </section>

        {/* Teams */}
        <section className="panelBlock teamBlock">
          <div className="sectionHeader">
            <span>Teams</span>
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setShowNewTeamModal(true)}
              title="新建 Team"
            />
          </div>
          {teams.length === 0 ? (
            <div style={{ padding: "8px 0", color: "var(--muted)", fontSize: 13 }}>
              暂无团队，点击 + 创建
            </div>
          ) : (
            teams.map((team) => (
              <div className="teamMember" key={team.id}>
                <span
                  className="teamAvatar"
                  style={{ "--agent-accent": agentAvatarColor(team.name) } as CSSProperties}
                >
                  {agentInitials(team.name)}
                </span>
                <div>
                  <strong>{team.name}</strong>
                  <small>{team.description || `${team.members.length} 名成员`}</small>
                </div>
                <button
                  className="miniRunBtn"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStartTeamRun(team.id);
                  }}
                  title="启动团队运行"
                >
                  Run
                </button>
              </div>
            ))
          )}
          {activeTeamRun && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
              <Tag color="processing">团队运行中: {activeTeamRun.status}</Tag>
            </div>
          )}
        </section>
      </aside>

      {/* ---- Chat Workbench ---- */}
      <section className="chatWorkbench" aria-label="会话区域">
        {!currentConversationId ? (
          /* Welcome Screen */
          <div className="welcomeScreen">
            <div className="welcomeContent">
              <h2>AgentHub Workbench</h2>
              <p>IM 风格多智能体协作平台</p>
              <div className="welcomeCards">
                <div className="welcomeCard">
                  <strong>快速开始</strong>
                  <span>点击左侧 + 创建新会话，或选择已有会话开始对话</span>
                </div>
                <div className="welcomeCard">
                  <strong>可用 Agents</strong>
                  <span>{agents.length > 0 ? `${agents.length} 个 Agent 就绪` : "默认 Claude Code Agent"}</span>
                </div>
                <div className="welcomeCard">
                  <strong>可用 Teams</strong>
                  <span>{teams.length > 0 ? `${teams.length} 个 Team 就绪` : "暂无团队"}</span>
                </div>
              </div>
            </div>
            {/* Composer for quick start */}
            <footer className="composer">
              <textarea
                aria-label="输入消息"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="输入消息，按 Enter 发送..."
              />
              <div className="composerFooter">
                <span>{notice || "选择或创建会话开始对话"}</span>
                <div className="runControls">
                  <Button
                    type="primary"
                    loading={isStreaming}
                    onClick={handleSend}
                    disabled={!chatInput.trim() || isStreaming}
                  >
                    发送
                  </Button>
                </div>
              </div>
            </footer>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <header className="chatHeader">
              <div>
                <span className="eyebrow">
                  {currentConversation?.type === "team" ? "Team Chat" : "Direct Chat"} ·{" "}
                  {currentConversation?.agentId ?? "Agent"}
                </span>
                <h1>{currentConversation?.title ?? "会话"}</h1>
              </div>
              <div className="headerBadges">
                <span className={`socketBadge ${socketState}`}>Socket {socketState}</span>
                <span className={`runBadge ${session.status}`}>
                  {isStreaming ? "流式中" : statusLabel(session.status)}
                </span>
                {currentConversation?.createdAt && (
                  <time>{formatTime(currentConversation.createdAt)}</time>
                )}
              </div>
            </header>

            {/* Chat Messages or Team Run View */}
            <div className="threadPane" ref={chatViewRef}>
              {currentConversation?.type === "team" ? (
                /* ---- Team Run View ---- */
                <div className="team-run-view" style={{ padding: 16 }}>
                  {!activeTeamRun ? (
                    <div className="emptyEvents">
                      <strong>团队会话</strong>
                      <span>发送消息启动团队编排运行</span>
                    </div>
                  ) : (
                    <>
                      {/* Status Banner */}
                      <div className="team-run-banner" style={{
                        padding: "12px 16px", borderRadius: 8, marginBottom: 16,
                        background: activeTeamRun.status === "succeeded" ? "#f0fdf4" :
                          activeTeamRun.status === "failed" ? "#fef2f2" : "#eff6ff",
                        border: `1px solid ${activeTeamRun.status === "succeeded" ? "#bbf7d0" :
                          activeTeamRun.status === "failed" ? "#fecaca" : "#bfdbfe"}`,
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <strong style={{ fontSize: 15 }}>
                            {activeTeamRun.status === "planning" ? "🔍 规划中..." :
                             activeTeamRun.status === "executing" ? "⚡ 执行中..." :
                             activeTeamRun.status === "verifying" ? "✅ 验证中..." :
                             activeTeamRun.status === "succeeded" ? "🎉 完成" :
                             activeTeamRun.status === "failed" ? "❌ 失败" : activeTeamRun.status}
                          </strong>
                          <Tag color={activeTeamRun.status === "succeeded" ? "success" :
                            activeTeamRun.status === "failed" ? "error" : "processing"}>
                            {activeTeamRun.status}
                          </Tag>
                        </div>
                        {activeTeamRun.plan && (
                          <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--muted)" }}>
                            {activeTeamRun.plan.summary}
                          </p>
                        )}
                      </div>

                      {/* Plan Tasks */}
                      {activeTeamRun.plan && (
                        <div style={{ marginBottom: 16 }}>
                          <strong style={{ fontSize: 14 }}>📋 任务计划</strong>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                            {activeTeamRun.plan.tasks.map((task, i) => {
                              const result = activeTeamRun.taskResults.find((tr) => tr.agentId === task.agentId);
                              const isDone = result?.status === "succeeded";
                              const isRunning = !result && activeTeamRun.status === "executing";
                              const agents = activeTeamRun.taskResults.filter(() => true);
                              const agentIndex = activeTeamRun.taskResults.findIndex((tr) => tr.agentId === task.agentId);
                              const prevDone = task.dependsOn.every((depId) =>
                                activeTeamRun.taskResults.some((tr) => tr.agentId === depId && tr.status === "succeeded")
                              );
                              return (
                                <div key={i} style={{
                                  padding: "10px 14px", borderRadius: 6,
                                  background: isDone ? "#f0fdf4" : isRunning ? "#eff6ff" : "#f8fafc",
                                  border: `1px solid ${isDone ? "#bbf7d0" : isRunning ? "#bfdbfe" : "#e2e8f0"}`,
                                  opacity: (!prevDone && !isDone && !isRunning) ? 0.5 : 1,
                                }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <Space size={8}>
                                      <Tag color="blue">{task.agentId}</Tag>
                                      <span style={{ fontSize: 13, fontWeight: 500 }}>
                                        {task.task.slice(0, 60)}{task.task.length > 60 ? "..." : ""}
                                      </span>
                                    </Space>
                                    <span style={{ fontSize: 12 }}>
                                      {isDone ? "✅ Done" : isRunning ? "⏳ Running..." : "⏸️ Waiting"}
                                    </span>
                                  </div>
                                  {task.dependsOn.length > 0 && (
                                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                                      依赖: {task.dependsOn.join(", ")}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Task Outputs */}
                      {activeTeamRun.taskResults.filter((tr) => tr.output).length > 0 && (
                        <div style={{ marginBottom: 16 }}>
                          <strong style={{ fontSize: 14 }}>📦 Agent 输出</strong>
                          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
                            {activeTeamRun.taskResults.filter((tr) => tr.output).map((tr) => (
                              <div key={tr.agentId} style={{
                                padding: 12, borderRadius: 6, background: "#f8fafc",
                                border: "1px solid #e2e8f0",
                              }}>
                                <Space size={8} style={{ marginBottom: 8 }}>
                                  <Tag color={tr.status === "succeeded" ? "success" : "error"}>
                                    {tr.agentId}
                                  </Tag>
                                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                                    {tr.status === "succeeded" ? "已完成" : "失败"}
                                  </span>
                                </Space>
                                <pre style={{
                                  fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word",
                                  maxHeight: 300, overflow: "auto", background: "#fff",
                                  padding: 8, borderRadius: 4, margin: 0,
                                }}>
                                  {tr.output.slice(0, 2000)}
                                  {tr.output.length > 2000 ? "\n... (output truncated)" : ""}
                                </pre>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Verdict */}
                      {activeTeamRun.verdict && (
                        <div style={{
                          padding: "12px 16px", borderRadius: 6, marginTop: 12,
                          background: activeTeamRun.verdict.verdict === "complete" ? "#f0fdf4" : "#fefce8",
                          border: `1px solid ${activeTeamRun.verdict.verdict === "complete" ? "#bbf7d0" : "#fde68a"}`,
                        }}>
                          <Space>
                            <Tag color={activeTeamRun.verdict.verdict === "complete" ? "success" : "warning"}>
                              {activeTeamRun.verdict.verdict === "complete" ? "Complete" : "Needs Rework"}
                            </Tag>
                            <strong style={{ fontSize: 14 }}>Verdict</strong>
                          </Space>
                          <p style={{ fontSize: 13, margin: "8px 0 0" }}>{activeTeamRun.verdict.summary}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                /* ---- Direct Chat Messages ---- */
                <>
                  {chatMessages.length === 0 && !streamingContent && (
                    <div className="emptyEvents">
                      <strong>开始对话</strong>
                      <span>在下方输入消息，与 Agent 开始对话。</span>
                    </div>
                  )}
                  {chatMessages.map((msg, idx) => (
                    <article
                      key={idx}
                      className={`messageRow ${msg.role === "user" ? "userMessage" : "assistantMessage"}`}
                    >
                      {msg.role === "assistant" && <div className="assistantAvatar">AI</div>}
                      <div className="messageBubble">
                        <span className="messageMeta">
                          {msg.role === "user" ? "You" : "Assistant"}
                        </span>
                        <p>{msg.content}</p>
                      </div>
                      {msg.role === "user" && <div className="assistantAvatar" style={{ background: "#2563eb" }}>U</div>}
                    </article>
                  ))}
                  {streamingContent && (
                    <article className="messageRow assistantMessage running">
                      <div className="assistantAvatar">AI</div>
                      <div className="messageBubble">
                        <span className="messageMeta">Assistant · 流式输出中</span>
                        <p>{streamingContent}</p>
                      </div>
                    </article>
                  )}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <footer className="composer">
              <textarea
                aria-label="输入消息"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="输入消息，按 Enter 发送..."
                disabled={isStreaming}
              />
              <div className="composerFooter">
                <span>{notice || (isStreaming ? "Agent 正在回复..." : "Ready")}</span>
                <div className="runControls">
                  <Button
                    type="primary"
                    loading={isStreaming}
                    onClick={handleSend}
                    disabled={!chatInput.trim() || isStreaming}
                  >
                    发送
                  </Button>
                </div>
              </div>
            </footer>
          </>
        )}
      </section>

      {/* ---- Inspector Panel ---- */}
      <aside className="inspectorPanel" aria-label="运行检查器与 artifacts">
        <section className="inspectorSection heroStatus">
          <div className="sectionHeader">
            <span>Run Inspector</span>
            <small>{session.id !== initialSession.id ? "真实会话" : "离线空态"}</small>
          </div>
          <strong>{isStreaming ? "流式中" : statusLabel(session.status)}</strong>
          <p>Conversation: {currentConversationId ?? "未选择"}</p>
        </section>

        <section className="inspectorSection">
          <div className="sectionHeader">
            <span>Contract Fields</span>
            <small>会话数据</small>
          </div>
          <dl className="kvList">
            <div><dt>Session ID</dt><dd>{session.id}</dd></div>
            <div><dt>Status</dt><dd>{session.status}</dd></div>
            <div><dt>Agent ID</dt><dd>{session.agentId ?? "N/A"}</dd></div>
            <div><dt>Conversation ID</dt><dd>{currentConversationId ?? "N/A"}</dd></div>
            <div><dt>Events</dt><dd>{events.length}</dd></div>
            <div><dt>Socket</dt><dd>{socketState}</dd></div>
          </dl>
        </section>

        <section className="inspectorSection">
          <div className="sectionHeader">
            <span>Artifacts</span>
            <small>数据快照</small>
          </div>
          <div className="artifactList">
            <div>
              <span>Conversations</span>
              <strong>{conversations.length} 个会话</strong>
            </div>
            <div>
              <span>Agents</span>
              <strong>{agents.length} 个 Agent</strong>
            </div>
            <div>
              <span>Teams</span>
              <strong>{teams.length} 个 Team</strong>
            </div>
            <div>
              <span>Messages</span>
              <strong>{chatMessages.length} 条消息</strong>
            </div>
          </div>
        </section>

        <section className="inspectorSection notePanel">
          <div className="sectionHeader">
            <span>Boundary</span>
            <small>no mock</small>
          </div>
          <p>
            会话列表、消息记录、Agent 和 Team 管理均来自后端 API。IM 风格聊天支持流式输出与历史回放。
          </p>
        </section>
      </aside>

      {/* ---- New Conversation Modal ---- */}
      <Modal
        title="新建会话"
        open={showNewConvModal}
        onOk={handleNewConversation}
        onCancel={() => {
          setShowNewConvModal(false);
          newConvForm.resetFields();
        }}
        okText="创建"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={newConvForm} layout="vertical" initialValues={{ type: "direct" }}>
          <Form.Item
            name="title"
            label="会话标题"
            rules={[{ required: true, message: "请输入会话标题" }]}
          >
            <Input placeholder="输入会话标题" />
          </Form.Item>
          <Form.Item name="type" label="会话类型" initialValue="direct">
            <Select
              onChange={(value) => {
                newConvForm.setFieldsValue({ agentId: undefined, teamId: undefined });
              }}
            >
              <Select.Option value="direct">Direct（单聊）</Select.Option>
              <Select.Option value="team">Team（团队）</Select.Option>
            </Select>
          </Form.Item>
          {convType === "direct" ? (
            <Form.Item
              name="agentId"
              label="选择 Agent"
              rules={[{ required: true, message: "请选择 Agent" }]}
            >
              <Select placeholder="选择 Agent">
                {agents.map((a) => (
                  <Select.Option key={a.id} value={a.id}>
                    {a.name} ({a.role})
                  </Select.Option>
                ))}
                {agents.length === 0 && <Select.Option value="claude">Claude Code</Select.Option>}
              </Select>
            </Form.Item>
          ) : (
            <Form.Item
              name="teamId"
              label="选择 Team"
              rules={[{ required: true, message: "请选择 Team" }]}
            >
              <Select placeholder="选择 Team">
                {teams.map((t) => (
                  <Select.Option key={t.id} value={t.id}>
                    {t.name} ({t.members.length} members)
                  </Select.Option>
                ))}
                {teams.length === 0 && (
                  <Select.Option value="" disabled>
                    暂无 Team，请先创建
                  </Select.Option>
                )}
              </Select>
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* ---- New Agent Modal ---- */}
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
        destroyOnClose
        width={520}
      >
        <Form form={newAgentForm} layout="vertical" initialValues={{ provider: "local-cli" }}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入 Agent 名称" }]}
          >
            <Input placeholder="e.g. Frontend Builder" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="简要描述 Agent 功能" />
          </Form.Item>
          <Form.Item
            name="provider"
            label="Provider"
            rules={[{ required: true, message: "请输入 Provider" }]}
          >
            <Select>
              <Select.Option value="local-cli">local-cli</Select.Option>
              <Select.Option value="openai">openai</Select.Option>
              <Select.Option value="anthropic">anthropic</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            rules={[{ required: true, message: "请输入角色描述" }]}
          >
            <Input placeholder="e.g. 前端开发专家" />
          </Form.Item>
          <Form.Item name="tags" label="标签（逗号分隔）">
            <Input placeholder="e.g. frontend, react, ui" />
          </Form.Item>
          <Form.Item name="systemPrompt" label="System Prompt">
            <Input.TextArea rows={4} placeholder="系统提示词..." />
          </Form.Item>
        </Form>
      </Modal>

      {/* ---- New Team Modal ---- */}
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
        destroyOnClose
        width={560}
      >
        <Form form={newTeamForm} layout="vertical">
          <Form.Item
            name="name"
            label="Team 名称"
            rules={[{ required: true, message: "请输入 Team 名称" }]}
          >
            <Input placeholder="e.g. Full-Stack Team" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="简要描述 Team 用途" />
          </Form.Item>
          <Form.Item
            name="members"
            label="成员选择"
            rules={[{ required: true, message: "请至少选择一名成员", type: "array", min: 1 }]}
          >
            <Checkbox.Group style={{ width: "100%" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {agents.length === 0 ? (
                  <span style={{ color: "var(--muted)", fontSize: 13 }}>
                    暂无 Agent，请先创建 Agent
                  </span>
                ) : (
                  agents.map((agent) => {
                    const fieldName = `memberRole_${agent.id}`;
                    return (
                      <div
                        key={agent.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "8px 12px",
                          border: "1px solid var(--line)",
                          borderRadius: 8,
                          background: "var(--surface)",
                        }}
                      >
                        <Checkbox
                          value={agent.id}
                          onChange={(e) => {
                            const currentMembers: TeamMemberConfig[] =
                              newTeamForm.getFieldValue("members") ?? [];
                            if (e.target.checked) {
                              const role: TeamMemberRole =
                                newTeamForm.getFieldValue(fieldName) ?? "worker";
                              newTeamForm.setFieldsValue({
                                members: [...currentMembers, { agentId: agent.id, role }],
                              });
                            } else {
                              newTeamForm.setFieldsValue({
                                members: currentMembers.filter(
                                  (m: TeamMemberConfig) => m.agentId !== agent.id,
                                ),
                              });
                            }
                          }}
                        />
                        <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>
                          {agent.name}
                        </span>
                        <span style={{ color: "var(--muted)", fontSize: 12 }}>
                          {agent.role}
                        </span>
                        <Select
                          size="small"
                          defaultValue="worker"
                          style={{ width: 100 }}
                          onChange={(role: TeamMemberRole) => {
                            newTeamForm.setFieldValue(fieldName, role);
                            const currentMembers: TeamMemberConfig[] =
                              newTeamForm.getFieldValue("members") ?? [];
                            newTeamForm.setFieldsValue({
                              members: currentMembers.map((m: TeamMemberConfig) =>
                                m.agentId === agent.id ? { ...m, role } : m,
                              ),
                            });
                          }}
                        >
                          <Select.Option value="leader">Leader</Select.Option>
                          <Select.Option value="worker">Worker</Select.Option>
                        </Select>
                      </div>
                    );
                  })
                )}
              </div>
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </main>
  );
}
