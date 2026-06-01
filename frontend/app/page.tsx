"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  AgentInstanceDto,
  AgentTemplateDto,
  CreateSessionAgentRequest,
  HubMessageDto,
  HubRunDto,
  HubSessionDto,
  SessionDetailDto,
  UpdateAgentRequest,
  UploadedAttachmentDto,
} from "@agenthub/shared";
import {
  BranchesOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  FileDoneOutlined,
  InboxOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PaperClipOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  SendOutlined,
  SearchOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  archiveSession,
  cancelRun,
  connectHubSocket,
  createSession,
  createSessionAgent,
  deleteSession,
  deleteAgent,
  getAuthState,
  getSessionDetail,
  listAgents,
  listAgentTemplates,
  listSessions,
  loginWithAccessKey,
  pinSessionMessage,
  sendSessionMessage,
  uploadSessionAttachment,
  updateSession,
  updateAgent,
  upsertById,
} from "../lib/agenthub-api";
import { ArtifactPanel, DiffPanel } from "./workbench/inspector";
import { RunBadge, RunThread, TimelineMessage } from "./workbench/timeline";
import {
  agentColor,
  initials,
  isRunning,
  readDirectAgentId,
  readMemberAgentIds,
  readOrchestratorAgentId,
  sessionMode,
  sessionSubtitle,
  sortArtifact,
  sortEvent,
  sortFileChange,
  sortMessage,
  sortRun,
  sortSession,
} from "../lib/workbench/format";
import {
  filterInviteTemplates,
  filterMentionCandidates,
  findActiveMention,
  parseMentionedAgentIds,
} from "../lib/workbench/mentions";
import { buildConversationItems } from "../lib/workbench/timeline";
import type { InspectorTab, MentionMatch } from "../lib/workbench/types";

const EMPTY_DETAIL: Omit<SessionDetailDto, "session"> = {
  messages: [],
  runs: [],
  events: [],
  artifacts: [],
  fileChanges: [],
};

export default function WorkbenchPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [sessions, setSessions] = useState<HubSessionDto[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionActionId, setSessionActionId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetailDto | null>(null);
  const [agents, setAgents] = useState<AgentInstanceDto[]>([]);
  const [templates, setTemplates] = useState<AgentTemplateDto[]>([]);
  const [composer, setComposer] = useState("");
  const [attachments, setAttachments] = useState<UploadedAttachmentDto[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("diff");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"direct" | "group">("direct");
  const [directTemplateId, setDirectTemplateId] = useState<number>(0);
  const [directName, setDirectName] = useState("");
  const [directProvider, setDirectProvider] = useState("claude-code");
  const [groupTitle, setGroupTitle] = useState("");
  const [orchTemplateId, setOrchTemplateId] = useState<number>(0);
  const [orchName, setOrchName] = useState("");
  const [orchSearch, setOrchSearch] = useState("");
  const [orchDropdownOpen, setOrchDropdownOpen] = useState(false);
  const selectedOrchTpl = templates.find((t) => t.id === orchTemplateId);

  function closeGroupDialog() {
    setGroupDialogOpen(false);
    setOrchSearch("");
    setOrchDropdownOpen(false);
  }
  const [orchProvider, setOrchProvider] = useState("claude-code");
  const [memberTemplates, setMemberTemplates] = useState<Array<{ templateId: number; provider: string; name: string }>>([]);
  const [contextMenu, setContextMenu] = useState<{ agentId: number; x: number; y: number } | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentInstanceDto | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteSelection, setInviteSelection] = useState<Array<{ templateId: number; provider: string; name: string }>>([]);
  const [inviteQuery, setInviteQuery] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentInstanceDto | null>(null);
  const [groupMembersExpanded, setGroupMembersExpanded] = useState(false);
  const [renamingSession, setRenamingSession] = useState(false);
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const activeSession = detail?.session ?? sessions.find((session) => session.id === activeSessionId) ?? null;
  const latestRun = detail?.runs.at(-1) ?? activeSession?.lastRun ?? null;
  const mode = sessionMode(activeSession);
  const directAgentId = readDirectAgentId(activeSession);
  const directAgent = directAgentId ? (agents.find((agent) => agent.id === directAgentId) ?? null) : null;
  const orchestratorAgentId = readOrchestratorAgentId(activeSession);
  const orchestrator = orchestratorAgentId
    ? (agents.find((agent) => agent.id === orchestratorAgentId) ?? null)
    : (agents.find((agent) => agent.isDefaultOrchestrator) ?? agents[0] ?? null);
  const workerAgents = agents.filter((agent) => !agent.isDefaultOrchestrator);
  const activeGroupMemberIds = useMemo(() => readMemberAgentIds(activeSession), [activeSession]);
  const activeGroupMembers = workerAgents.filter((agent) => activeGroupMemberIds.includes(agent.id));
  const composerAgents = mode === "direct" ? (directAgent ? [directAgent] : []) : activeGroupMembers;
  const mentionCandidates = useMemo(
    () => filterMentionCandidates(composerAgents, mentionMatch?.query ?? ""),
    [composerAgents, mentionMatch?.query],
  );
  const filteredInviteTemplates = useMemo(
    () => filterInviteTemplates(templates, inviteQuery),
    [templates, inviteQuery],
  );
  const parsedMentionIds = useMemo(() => parseMentionedAgentIds(composer, composerAgents), [composer, composerAgents]);
  const conversationItems = useMemo(() => buildConversationItems(detail), [detail]);

  useEffect(() => {
    void checkAuth();
  }, []);

  useEffect(() => {
    if (!authenticated || !authChecked) return;
    const timer = window.setTimeout(() => {
      void refreshSessions(sessionSearch);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [authenticated, authChecked, sessionSearch]);

  useEffect(() => {
    if (!authenticated || !activeSessionId) return;
    const disconnect = connectHubSocket(activeSessionId, {
      onState: () => undefined,
      onEvent: (event) => {
        setDetail((current) =>
          current ? { ...current, events: upsertById(current.events, event).sort(sortEvent) } : current,
        );
        if (event.eventType === "artifact.upsert" || event.eventType === "artifact.complete") {
          setInspectorTab("artifacts");
        }
        if (event.eventType === "file.change") {
          setInspectorTab("diff");
        }
      },
      onSession: (session) => {
        setSessions((current) => upsertById(current, session).sort(sortSession));
        setDetail((current) => (current?.session.id === session.id ? { ...current, session } : current));
      },
      onArtifact: (artifact) => {
        setDetail((current) =>
          current ? { ...current, artifacts: upsertById(current.artifacts, artifact).sort(sortArtifact) } : current,
        );
      },
      onFileChange: (fileChange) => {
        setDetail((current) =>
          current ? { ...current, fileChanges: upsertById(current.fileChanges, fileChange).sort(sortFileChange) } : current,
        );
      },
    });
    return disconnect;
  }, [authenticated, activeSessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [conversationItems.length, detail?.events.length]);

  useEffect(() => {
    if (activeMentionIndex >= mentionCandidates.length) {
      setActiveMentionIndex(0);
    }
  }, [activeMentionIndex, mentionCandidates.length]);

  async function checkAuth() {
    const result = await getAuthState();
    if (result.ok && result.data.authenticated) {
      setAuthenticated(true);
      await bootstrap();
    } else {
      setAuthenticated(false);
      if (result.ok && !result.data.configured) {
        setAuthError("后端未配置访问密钥");
      }
    }
    setAuthChecked(true);
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = accessKey.trim();
    if (!key || authSubmitting) return;
    setAuthSubmitting(true);
    setAuthError("");
    try {
      const result = await loginWithAccessKey(key);
      if (!result.ok) {
        setAuthError("密钥无效");
        return;
      }
      setAuthenticated(true);
      setAccessKey("");
      await bootstrap();
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function bootstrap() {
    const [agentRes, templateRes, sessionRes] = await Promise.all([
      listAgents(),
      listAgentTemplates(),
      listSessions({ query: sessionSearch }),
    ]);
    if (agentRes.ok) setAgents(agentRes.data.items);
    if (templateRes.ok) setTemplates(templateRes.data);

    if (!sessionRes.ok) {
      setNotice(`后端不可用：${sessionRes.error}`);
      return;
    }

    const items = sessionRes.data.items;
    setSessions(items);
    const selected = items[0]?.id ?? null;
    setActiveSessionId(selected);
    if (selected) {
      await loadSession(selected);
    } else {
      setDetail(null);
    }
  }

  async function refreshSessions(query = sessionSearch) {
    const result = await listSessions({ query });
    if (!result.ok) {
      setNotice(`会话列表加载失败：${result.error}`);
      return;
    }
    setSessions(result.data.items);
  }

  async function loadSession(sessionId: string) {
    setActiveSessionId(sessionId);
    setRenamingSession(false);
    setAttachments([]);
    const result = await getSessionDetail(sessionId);
    if (!result.ok) {
      setNotice(`会话加载失败：${result.error}`);
      return;
    }
    setDetail(result.data);
    closeMentionMenu();
  }

  async function handleToggleSessionPin(session: HubSessionDto) {
    if (sessionActionId) return;
    setSessionActionId(session.id);
    try {
      const result = await updateSession(session.id, { isPinned: !session.isPinned });
      if (!result.ok) {
        setNotice(`置顶失败：${result.error}`);
        return;
      }
      setSessions((current) => upsertById(current, result.data).sort(sortSession));
      setDetail((current) => (current?.session.id === result.data.id ? { ...current, session: result.data } : current));
    } finally {
      setSessionActionId(null);
    }
  }

  function beginRenameSession() {
    if (!activeSession) return;
    setSessionTitleDraft(activeSession.title);
    setRenamingSession(true);
  }

  async function handleRenameSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeSession || sessionActionId) return;
    const title = sessionTitleDraft.trim();
    if (!title) return;
    setSessionActionId(activeSession.id);
    try {
      const result = await updateSession(activeSession.id, { title });
      if (!result.ok) {
        setNotice(`重命名失败：${result.error}`);
        return;
      }
      setSessions((current) => upsertById(current, result.data).sort(sortSession));
      setDetail((current) => (current?.session.id === result.data.id ? { ...current, session: result.data } : current));
      setRenamingSession(false);
    } finally {
      setSessionActionId(null);
    }
  }

  async function handleArchiveSession(session: HubSessionDto) {
    if (sessionActionId || isRunning(session.lastRun?.status ?? "")) return;
    if (!window.confirm(`归档会话「${session.title}」？`)) return;
    setSessionActionId(session.id);
    try {
      const result = await archiveSession(session.id);
      if (!result.ok) {
        setNotice(`归档失败：${result.error}`);
        return;
      }
      const nextSessions = sessions.filter((item) => item.id !== session.id).sort(sortSession);
      setSessions(nextSessions);
      if (activeSessionId === session.id) {
        const next = nextSessions[0] ?? null;
        setActiveSessionId(next?.id ?? null);
        setDetail(null);
        if (next) await loadSession(next.id);
      }
    } finally {
      setSessionActionId(null);
    }
  }

  async function handleDeleteSession(session: HubSessionDto) {
    if (sessionActionId || isRunning(session.lastRun?.status ?? "")) return;
    if (!window.confirm(`删除会话「${session.title}」？历史记录会保留在数据库中。`)) return;
    setSessionActionId(session.id);
    try {
      const result = await deleteSession(session.id);
      if (!result.ok) {
        setNotice(`删除失败：${result.error}`);
        return;
      }
      const nextSessions = sessions.filter((item) => item.id !== session.id).sort(sortSession);
      setSessions(nextSessions);
      if (activeSessionId === session.id) {
        const next = nextSessions[0] ?? null;
        setActiveSessionId(next?.id ?? null);
        setDetail(null);
        if (next) await loadSession(next.id);
      }
    } finally {
      setSessionActionId(null);
    }
  }

  function openCreateGroupDialog() {
    setCreateMode("direct");
    setDirectTemplateId(0);
    setDirectName("");
    setDirectProvider("claude-code");
    setGroupTitle("");
    setOrchTemplateId(0);
    setOrchName("");
    setOrchProvider("claude-code");
    setMemberTemplates([]);
    setGroupDialogOpen(true);
  }

  async function handleCreateGroup() {
    if (createMode === "direct" && !directTemplateId) {
      setNotice("请选择单聊 Agent 模板");
      return;
    }
    if (createMode === "group" && !orchTemplateId) {
      setNotice("请选择 Orchestrator 模板");
      return;
    }
    const result = await createSession({
      mode: createMode,
      title: groupTitle.trim() || undefined,
      directTemplateId: createMode === "direct" ? directTemplateId : undefined,
      directName: createMode === "direct" ? directName.trim() || undefined : undefined,
      directProvider: createMode === "direct" ? directProvider : undefined,
      orchestratorTemplateId: createMode === "group" ? orchTemplateId : undefined,
      orchestratorName: createMode === "group" ? orchName || undefined : undefined,
      orchestratorProvider: createMode === "group" ? orchProvider : undefined,
      memberTemplates: createMode === "group" && memberTemplates.length > 0 ? memberTemplates : undefined,
    });
    if (!result.ok) {
      setNotice(`创建失败：${result.error}`);
      return;
    }
    setSessions((current) => upsertById(current, result.data).sort(sortSession));
    setDetail({ session: result.data, ...EMPTY_DETAIL });
    setActiveSessionId(result.data.id);
    const agentRes = await listAgents();
    if (agentRes.ok) setAgents(agentRes.data.items);
    closeMentionMenu();
    closeGroupDialog();
  }

  async function handleSend() {
    const text = composer.trim();
    if (!text || !activeSessionId || sending) return;
    setSending(true);
    setComposer("");
    closeMentionMenu();
    try {
      const targetAgentIds =
        mode === "direct" ? [] : parsedMentionIds.length > 0 ? parsedMentionIds : composerAgents.map((agent) => agent.id);
      const result = await sendSessionMessage(activeSessionId, {
        content: text,
        mentionedAgentIds: targetAgentIds,
        orchestratorAgentId: mode === "direct" ? directAgent?.id : orchestrator?.id,
        attachments: attachments.map((item) => ({ id: item.id })),
      });
      if (!result.ok) {
        setNotice(`发送失败：${result.error}`);
        return;
      }
      setDetail((current) => {
        const base = current ?? { session: result.data.session, ...EMPTY_DETAIL };
        return {
          ...base,
          session: result.data.session,
          messages: upsertById(base.messages, result.data.message).sort(sortMessage),
          runs: upsertById(base.runs, result.data.run).sort(sortRun),
        };
      });
      setSessions((current) => upsertById(current, result.data.session).sort(sortSession));
      setAttachments([]);
      setNotice(mode === "direct" ? "消息已发送给 Agent" : "消息已发送给 Orchestrator");
    } finally {
      setSending(false);
    }
  }

  async function handlePin(message: HubMessageDto) {
    if (!activeSessionId) return;
    const result = await pinSessionMessage(activeSessionId, message.id, { pinned: !message.isPinned });
    if (!result.ok) {
      setNotice(`Pin 失败：${result.error}`);
      return;
    }
    setDetail((current) =>
      current ? { ...current, messages: upsertById(current.messages, result.data).sort(sortMessage) } : current,
    );
  }

  async function handleCancel(run: HubRunDto) {
    if (!activeSessionId || cancellingRunId) return;
    setCancellingRunId(run.id);
    try {
      const result = await cancelRun(activeSessionId, run.id);
      setNotice(result.ok ? "已请求取消当前 run" : `取消失败：${result.error}`);
      if (result.ok) {
        setDetail((current) => {
          if (!current) return current;
          return {
            ...current,
            runs: current.runs.map((r) =>
              r.id === run.id ? { ...r, status: "cancelled" as const, completedAt: new Date().toISOString() } : r,
            ),
          };
        });
      }
    } finally {
      setCancellingRunId(null);
    }
  }

  async function handleEditAgent(body: UpdateAgentRequest) {
    if (!editTarget) return;
    const result = await updateAgent(editTarget.id, body);
    if (!result.ok) {
      setNotice(`编辑失败：${result.error}`);
      return;
    }
    setAgents((current) => upsertById(current, result.data));
    setEditDialogOpen(false);
    setEditTarget(null);
    setNotice(`Agent "${result.data.name}" 已更新`);
  }

  async function handleDeleteAgent() {
    if (!deleteTarget) return;
    const result = await deleteAgent(deleteTarget.id);
    if (!result.ok) {
      setNotice(`删除失败：${result.error}`);
      return;
    }
    setAgents((current) => current.filter((agent) => agent.id !== deleteTarget.id));
    setDetail((current) => {
      if (!current) return current;
      const memberAgentIds = readMemberAgentIds(current.session).filter((id) => id !== deleteTarget.id);
      return {
        ...current,
        session: {
          ...current.session,
          metadata: { ...current.session.metadata, memberAgentIds },
        },
      };
    });
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
    setNotice(`Agent "${deleteTarget.name}" 已移除`);
  }

  function openAgentTemplateDialog() {
    window.location.href = "/agent-templates/build";
  }

  async function handleInviteAgent() {
    if (!activeSessionId) return;
    const selected = inviteSelection.filter((item) => item.templateId);
    if (selected.length === 0) {
      setNotice("请至少选择一个模板");
      return;
    }
    let errorCount = 0;
    for (const item of selected) {
      const body: CreateSessionAgentRequest = {
        sessionId: activeSessionId,
        templateId: item.templateId,
        provider: item.provider,
        name: item.name.trim() || templates.find((tpl) => tpl.id === item.templateId)?.name || "Agent",
      };
      const result = await createSessionAgent(body);
      if (result.ok) {
        setAgents((current) => upsertById(current, result.data));
      } else {
        errorCount++;
      }
    }
    setInviteDialogOpen(false);
    setInviteQuery("");
    setNotice(errorCount > 0 ? `${selected.length - errorCount} 个 Agent 已加入，${errorCount} 个失败` : `${selected.length} 个 Agent 已加入`);
  }

  function closeMentionMenu() {
    setMentionMatch(null);
    setActiveMentionIndex(0);
  }

  function refreshMentionMenu(value: string, caret: number | null) {
    const next = findActiveMention(value, caret ?? value.length);
    setMentionMatch(next);
    setActiveMentionIndex(0);
  }

  function insertMention(agent: AgentInstanceDto) {
    if (!mentionMatch) return;
    const token = `@${agent.name} `;
    const next = `${composer.slice(0, mentionMatch.start)}${token}${composer.slice(mentionMatch.end)}`;
    const caret = mentionMatch.start + token.length;
    setComposer(next);
    closeMentionMenu();
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  async function handleAttachmentFiles(files: FileList | null) {
    if (!activeSessionId || !files?.length || uploadingAttachment) return;
    const selected = Array.from(files).slice(0, Math.max(0, 5 - attachments.length));
    if (selected.length === 0) {
      setNotice("单条消息最多 5 个附件");
      return;
    }
    setUploadingAttachment(true);
    try {
      for (const file of selected) {
        if (file.size > 50 * 1024 * 1024) {
          setNotice(`${file.name} 超过 50MB`);
          continue;
        }
        const result = await uploadSessionAttachment(activeSessionId, file);
        if (result.ok) {
          setAttachments((current) => [...current, result.data].slice(0, 5));
        } else {
          setNotice(`附件上传失败：${result.error}`);
        }
      }
    } finally {
      setUploadingAttachment(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (!authChecked) {
    return (
      <main className="authShell">
        <section className="authPanel">
          <strong>AgentHub</strong>
          <span>正在检查访问状态...</span>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="authShell">
        <form className="authPanel" onSubmit={(event) => void handleLogin(event)}>
          <div>
            <strong>AgentHub</strong>
            <span>输入访问密钥后继续</span>
          </div>
          <input
            aria-label="访问密钥"
            autoFocus
            type="password"
            value={accessKey}
            onChange={(event) => setAccessKey(event.target.value)}
            placeholder="访问密钥"
          />
          {authError && <small className="authError">{authError}</small>}
          <button className="primaryButton" type="submit" disabled={!accessKey.trim() || authSubmitting}>
            {authSubmitting ? <LoadingOutlined /> : null}
            <span>进入</span>
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className={`agenthubShell ${inspectorCollapsed ? "inspectorCollapsed" : ""}`}>
      <aside className="sessionRail">
        <div className="railHeader">
          <div>
            <strong>AgentHub</strong>
            <span>多 Agent 群聊</span>
          </div>
          <button className="iconButton" type="button" title="新建 Agent 模板" onClick={openAgentTemplateDialog}>
            <PlusOutlined />
          </button>
          <button className="iconButton" type="button" title="新建对话" onClick={openCreateGroupDialog}>
            <TeamOutlined />
          </button>
        </div>

        <div className="statusStack">
          <section className="groupSummary">
            <button
              className="groupSummaryHeader"
              type="button"
              onClick={() => setGroupMembersExpanded((v) => !v)}
            >
              <strong>{mode === "direct" ? "单聊 Agent" : "群聊成员"}</strong>
              <span>
                {mode === "direct"
                  ? directAgent?.name ?? "未选择 Agent"
                  : composerAgents.length
                    ? `${composerAgents.length} 个 Agent`
                    : "未选择成员"}
              </span>
            </button>
            {groupMembersExpanded && (
              <div className="memberList">
                {(mode === "direct"
                  ? (directAgent ? [directAgent] : [])
                  : (orchestrator ? [orchestrator] : []).concat(activeGroupMembers)
                ).map((agent) => (
                  <div
                    key={agent.id}
                    className="memberRow"
                    onContextMenu={(e) => {
                      if (mode !== "group" || agent.id === orchestrator?.id) return;
                      e.preventDefault();
                      setContextMenu({ agentId: agent.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="avatar" style={{ background: agentColor(agent.id) }}>
                      {initials(agent.name)}
                    </span>
                    <span className="memberName">{agent.name}</span>
                    {mode === "group" && agent.id === orchestrator?.id && <span className="memberOrchTag">协调者</span>}
                  </div>
                ))}
                {mode === "group" && (
                  <button
                    className="addMemberRow"
                    type="button"
                    onClick={() => {
                      setInviteSelection([]);
                      setInviteQuery("");
                      setInviteDialogOpen(true);
                    }}
                  >
                    <PlusOutlined />
                    <span>添加成员</span>
                  </button>
                )}
              </div>
            )}
          </section>
        </div>

        <label className="sessionSearch">
          <SearchOutlined />
          <input
            value={sessionSearch}
            onChange={(event) => setSessionSearch(event.target.value)}
            placeholder="搜索会话、最近消息、Agent"
          />
        </label>

        <nav className="sessionList" aria-label="会话">
          {sessions.length === 0 && <p className="emptySessionList">没有匹配的会话</p>}
          {sessions.map((session) => {
            const sessionBusy = isRunning(session.lastRun?.status ?? "");
            const actionBusy = sessionActionId === session.id;
            return (
              <div
                key={session.id}
                className={`sessionItem ${session.id === activeSessionId ? "active" : ""}`}
              >
                <button className="sessionItemMain" type="button" onClick={() => void loadSession(session.id)}>
                  <span>
                    {session.isPinned && <PushpinFilled />}
                    <span>{session.title}</span>
                  </span>
                  <small>{sessionSubtitle(session)}</small>
                </button>
                <div className="sessionItemActions">
                  <button
                    className="iconButton"
                    type="button"
                    title={session.isPinned ? "取消置顶" : "置顶"}
                    disabled={actionBusy}
                    onClick={() => void handleToggleSessionPin(session)}
                  >
                    {session.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
                  </button>
                  <button
                    className="iconButton"
                    type="button"
                    title={sessionBusy ? "运行中不能归档" : "归档"}
                    disabled={actionBusy || sessionBusy}
                    onClick={() => void handleArchiveSession(session)}
                  >
                    <InboxOutlined />
                  </button>
                  <button
                    className="iconButton dangerIcon"
                    type="button"
                    title={sessionBusy ? "运行中不能删除" : "删除"}
                    disabled={actionBusy || sessionBusy}
                    onClick={() => void handleDeleteSession(session)}
                  >
                    <DeleteOutlined />
                  </button>
                </div>
              </div>
            );
          })}
        </nav>
      </aside>

      <section className="conversationPane">
        <header className="conversationHeader">
          <div className="conversationTitleBlock">
            {renamingSession && activeSession ? (
              <form className="titleEditForm" onSubmit={(event) => void handleRenameSession(event)}>
                <input
                  value={sessionTitleDraft}
                  onChange={(event) => setSessionTitleDraft(event.target.value)}
                  autoFocus
                />
                <button className="primaryButton" type="submit" disabled={!sessionTitleDraft.trim() || sessionActionId === activeSession.id}>
                  保存
                </button>
                <button className="ghostButton" type="button" onClick={() => setRenamingSession(false)}>
                  取消
                </button>
              </form>
            ) : (
              <>
                <strong>{activeSession?.title ?? "AgentHub 群聊"}</strong>
                {notice && <span>{notice}</span>}
              </>
            )}
          </div>
          <div className="headerActions">
            {activeSession && !renamingSession && (
              <button className="iconButton" type="button" title="重命名会话" onClick={beginRenameSession}>
                <EditOutlined />
              </button>
            )}
            {latestRun && <RunBadge run={latestRun} />}
            {latestRun && isRunning(latestRun.status) && (
              <button
                className="ghostButton"
                type="button"
                disabled={cancellingRunId === latestRun.id}
                onClick={() => void handleCancel(latestRun)}
              >
                {cancellingRunId === latestRun.id ? "取消中..." : "取消"}
              </button>
            )}
          </div>
        </header>

        <div className="timeline">
          {conversationItems.map((item) =>
            item.kind === "message" ? (
              <TimelineMessage key={item.id} message={item.message} onPin={handlePin} agents={agents} />
            ) : (
              <RunThread
                key={item.id}
                run={item.run}
                events={item.events}
                messages={item.messages}
                agents={agents}
              />
            ),
          )}
          <div ref={endRef} />
        </div>

        <footer className="composer">
          <div className="composerInputWrap">
            {mentionMatch && !sending && activeSessionId && (
              <div className="mentionMenu" role="listbox" aria-label="Agent mention 候选">
                {mentionCandidates.length > 0 ? (
                  mentionCandidates.map((agent, index) => (
                    <button
                      key={agent.id}
                      className={index === activeMentionIndex ? "active" : ""}
                      type="button"
                      role="option"
                      aria-selected={index === activeMentionIndex}
                      onMouseEnter={() => setActiveMentionIndex(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        insertMention(agent);
                      }}
                    >
                      <span className="avatar" style={{ background: agentColor(agent.id) }}>
                        {initials(agent.name)}
                      </span>
                      <span>
                        <strong>@{agent.name}</strong>
                        <small>{agent.template?.name ?? "worker"}</small>
                      </span>
                      {index === activeMentionIndex && <CheckCircleOutlined />}
                    </button>
                  ))
                ) : (
                  <p>没有匹配的 Agent</p>
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={composer}
              onChange={(event) => {
                setComposer(event.target.value);
                refreshMentionMenu(event.target.value, event.target.selectionStart);
              }}
              onClick={(event) => refreshMentionMenu(event.currentTarget.value, event.currentTarget.selectionStart)}
              onSelect={(event) => refreshMentionMenu(event.currentTarget.value, event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                if (mentionMatch) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveMentionIndex((current) =>
                      mentionCandidates.length ? (current + 1) % mentionCandidates.length : 0,
                    );
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveMentionIndex((current) =>
                      mentionCandidates.length ? (current - 1 + mentionCandidates.length) % mentionCandidates.length : 0,
                    );
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    const selected = mentionCandidates[activeMentionIndex] ?? mentionCandidates[0];
                    if (selected) insertMention(selected);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeMentionMenu();
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={mode === "direct" ? "输入要交给这个 Agent 的任务" : "输入任务，使用 @frontend-agent 指定群聊成员"}
              disabled={sending || !activeSessionId || (mode === "direct" && !directAgent)}
            />
          </div>
          <div className="composerBar">
            <span>
              {mode === "direct"
                ? directAgent
                  ? `单聊：${directAgent.name}`
                  : "请选择单聊 Agent"
                : parsedMentionIds.length
                ? `将发送给 ${parsedMentionIds.length} 个 Agent`
                : composerAgents.length
                  ? `群聊成员 ${composerAgents.length} 个 Agent`
                  : "默认由主 Orchestrator 协调"}
            </span>
            <input
              ref={fileInputRef}
              className="hiddenFileInput"
              type="file"
              multiple
              onChange={(event) => void handleAttachmentFiles(event.target.files)}
            />
            <button
              className="iconButton"
              type="button"
              title="上传附件"
              disabled={!activeSessionId || uploadingAttachment || attachments.length >= 5}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingAttachment ? <LoadingOutlined /> : <PaperClipOutlined />}
            </button>
            <button
              className="primaryButton"
              type="button"
              disabled={!composer.trim() || sending || !activeSessionId || (mode === "direct" && !directAgent)}
              onClick={() => void handleSend()}
            >
              {sending ? <LoadingOutlined /> : <SendOutlined />}
              <span>发送</span>
            </button>
          </div>
          {attachments.length > 0 && (
            <div className="attachmentTray">
              {attachments.map((attachment) => (
                <span className="attachmentChip" key={attachment.id}>
                  <PaperClipOutlined />
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    title="移除附件"
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </footer>
      </section>

      <aside className={`inspector ${inspectorCollapsed ? "collapsed" : ""}`}>
        <div className="inspectorTabs">
          <button
            className="inspectorToggle"
            type="button"
            title={inspectorCollapsed ? "展开 Inspector" : "收起 Inspector"}
            onClick={() => setInspectorCollapsed((current) => !current)}
          >
            {inspectorCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            <span>{inspectorCollapsed ? "展开" : "收起"}</span>
          </button>
          <button className={inspectorTab === "diff" ? "active" : ""} type="button" onClick={() => setInspectorTab("diff")}>
            <BranchesOutlined />
            <span>Diff</span>
          </button>
          <button
            className={inspectorTab === "artifacts" ? "active" : ""}
            type="button"
            onClick={() => setInspectorTab("artifacts")}
          >
            <FileDoneOutlined />
            <span>Artifacts</span>
          </button>
        </div>

        {!inspectorCollapsed && (
          <>
            {inspectorTab === "diff" && <DiffPanel changes={detail?.fileChanges ?? []} />}
            {inspectorTab === "artifacts" && <ArtifactPanel artifacts={detail?.artifacts ?? []} />}
          </>
        )}
      </aside>

      {groupDialogOpen && (
        <div className="dialogLayer" role="presentation" onMouseDown={closeGroupDialog}>
          <section
            className="groupDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-group-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong id="create-group-title">新建对话</strong>
                <span>先选择单聊或群聊模式，再选择 Agent 模板</span>
              </div>
            </header>
            <div className="modeSwitch" role="tablist" aria-label="对话模式">
              <button
                className={createMode === "direct" ? "active" : ""}
                type="button"
                onClick={() => setCreateMode("direct")}
              >
                单聊
              </button>
              <button
                className={createMode === "group" ? "active" : ""}
                type="button"
                onClick={() => setCreateMode("group")}
              >
                群聊
              </button>
            </div>
            <div className="buildForm">
              <label>
                对话名称
                <input value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} placeholder="留空后使用首条消息摘要" />
              </label>
              {createMode === "direct" ? (
                <>
                  <label>
                    Agent 模板
                    <select
                      value={directTemplateId}
                      onChange={(event) => {
                        const nextId = Number(event.target.value);
                        setDirectTemplateId(nextId);
                        const tpl = templates.find((item) => item.id === nextId);
                        if (tpl) setDirectProvider(tpl.defaultProvider);
                      }}
                    >
                      <option value={0}>选择模板</option>
                      {templates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Agent 名称
                    <input
                      value={directName}
                      onChange={(e) => setDirectName(e.target.value)}
                      placeholder={templates.find((tpl) => tpl.id === directTemplateId)?.name ?? "不填则自动加序号"}
                    />
                  </label>
                  <label>
                    Provider
                    <select value={directProvider} onChange={(e) => setDirectProvider(e.target.value)}>
                      <option value="claude-code">claude-code</option>
                      <option value="open-code">open-code</option>
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Orchestrator
                    <div className="searchableSelect">
                      <input
                        value={orchDropdownOpen ? orchSearch : (selectedOrchTpl?.name ?? "")}
                        placeholder="搜索模板…"
                        onFocus={() => { setOrchSearch(""); setOrchDropdownOpen(true); }}
                        onChange={(e) => setOrchSearch(e.target.value)}
                        onBlur={() => setTimeout(() => setOrchDropdownOpen(false), 150)}
                      />
                      {orchDropdownOpen && (
                        <div className="searchableDropdown">
                          {templates
                            .filter((tpl) => !orchSearch || tpl.name.toLowerCase().includes(orchSearch.toLowerCase()))
                            .map((tpl) => (
                              <div
                                key={tpl.id}
                                className={`searchableOption ${orchTemplateId === tpl.id ? "active" : ""}`}
                                onMouseDown={() => { setOrchTemplateId(tpl.id); setOrchDropdownOpen(false); }}
                              >
                                <strong>{tpl.name}</strong>
                                <small>{tpl.description.slice(0, 50)}</small>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </label>
                  {orchTemplateId !== 0 && (
                    <>
                      <label>
                        Orchestrator 名称
                        <input
                          value={orchName}
                          onChange={(e) => setOrchName(e.target.value)}
                          placeholder={selectedOrchTpl?.name ?? "不填则自动加序号"}
                        />
                      </label>
                      <label>
                        Orchestrator Provider
                        <select value={orchProvider} onChange={(e) => setOrchProvider(e.target.value)}>
                          <option value="claude-code">claude-code</option>
                          <option value="open-code">open-code</option>
                        </select>
                      </label>
                    </>
                  )}
                  <label>群成员模板（多选）</label>
                </>
              )}
            </div>
            {createMode === "group" && <div className="agentChoiceList">
              {templates.length === 0 && <p className="dialogHint">暂无可用的 Agent 模板，请先创建模板。</p>}
              {templates.map((tpl) => {
                const selected = memberTemplates.some((m) => m.templateId === tpl.id);
                return (
                  <div
                    key={tpl.id}
                    className={`agentChoice ${selected ? "selected" : ""}`}
                  >
                    <button
                      className="agentChoiceMain"
                      type="button"
                      onClick={() =>
                        setMemberTemplates((current) =>
                          selected
                            ? current.filter((m) => m.templateId !== tpl.id)
                            : [...current, { templateId: tpl.id, provider: tpl.defaultProvider, name: tpl.name }],
                        )
                      }
                    >
                      <span className="avatar" style={{ background: agentColor(tpl.id) }}>
                        {initials(tpl.name)}
                      </span>
                      <span>
                        <strong>{tpl.name}</strong>
                        <small>{tpl.description.slice(0, 40)}</small>
                      </span>
                    </button>
                    {selected && (
                      <div className="agentChoiceConfig">
                        <input
                          value={memberTemplates.find((m) => m.templateId === tpl.id)?.name ?? tpl.name}
                          onChange={(e) =>
                            setMemberTemplates((current) =>
                              current.map((m) =>
                                m.templateId === tpl.id ? { ...m, name: e.target.value } : m,
                              ),
                            )
                          }
                          placeholder="实例名称"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <select
                          value={memberTemplates.find((m) => m.templateId === tpl.id)?.provider ?? "claude-code"}
                          onChange={(e) => {
                            e.stopPropagation();
                            setMemberTemplates((current) =>
                              current.map((m) =>
                                m.templateId === tpl.id ? { ...m, provider: e.target.value } : m,
                              ),
                            );
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="claude-code">claude-code</option>
                          <option value="open-code">open-code</option>
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>}
            <footer>
              <button className="ghostButton" type="button" onClick={closeGroupDialog}>
                取消
              </button>
              <button
                className="primaryButton"
                type="button"
                disabled={createMode === "direct" ? !directTemplateId : !orchTemplateId}
                onClick={() => void handleCreateGroup()}
              >
                创建对话
              </button>
            </footer>
          </section>
        </div>
      )}

      {contextMenu && (
        <div
          className="contextMenuOverlay"
          role="presentation"
          onClick={() => setContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
        >
          <div
            className="contextMenu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="contextMenuItem"
              type="button"
              role="menuitem"
              onClick={() => {
                const agent = agents.find((a) => a.id === contextMenu.agentId);
                if (agent) {
                  setEditTarget(agent);
                  setEditDialogOpen(true);
                }
                setContextMenu(null);
              }}
            >
              <EditOutlined /> 编辑
            </button>
            <button
              className="contextMenuItem danger"
              type="button"
              role="menuitem"
              onClick={() => {
                const agent = agents.find((a) => a.id === contextMenu.agentId);
                if (agent) {
                  setDeleteTarget(agent);
                  setDeleteConfirmOpen(true);
                }
                setContextMenu(null);
              }}
            >
              <DeleteOutlined /> 从群聊中移除
            </button>
          </div>
        </div>
      )}

      {editDialogOpen && editTarget && (
        <div className="dialogLayer" role="presentation" onMouseDown={() => { setEditDialogOpen(false); setEditTarget(null); }}>
          <section
            className="agentDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-agent-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <strong id="edit-agent-title">编辑 Agent</strong>
                <span>修改 {editTarget.name} 的配置</span>
              </div>
            </header>
            <div className="buildForm">
              <label>名称
                <input
                  value={editTarget.name}
                  onChange={(e) => setEditTarget({ ...editTarget, name: e.target.value })}
                />
              </label>
              <label>描述
                <textarea
                  value={editTarget.description}
                  onChange={(e) => setEditTarget({ ...editTarget, description: e.target.value })}
                  rows={2}
                />
              </label>
              <label>Provider
                <select
                  value={editTarget.provider}
                  onChange={(e) => setEditTarget({ ...editTarget, provider: e.target.value })}
                >
                  <option value="claude-code">claude-code</option>
                  <option value="open-code">open-code</option>
                </select>
              </label>
            </div>
            <footer>
              <button className="ghostButton" type="button" onClick={() => { setEditDialogOpen(false); setEditTarget(null); }}>
                取消
              </button>
              <button
                className="primaryButton"
                type="button"
                disabled={!editTarget.name.trim()}
                onClick={() => handleEditAgent({
                  name: editTarget.name,
                  description: editTarget.description,
                  provider: editTarget.provider,
                })}
              >
                保存
              </button>
            </footer>
          </section>
        </div>
      )}

      {inviteDialogOpen && (
        <div className="dialogLayer" role="presentation" onMouseDown={() => setInviteDialogOpen(false)}>
          <section
            className="agentDialog inviteAgentDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-agent-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <strong id="invite-agent-title">邀请 Agent 加入群聊</strong>
                <span>选择模板并设置名称和 Provider</span>
              </div>
            </header>
            <div className="inviteSearchBar">
              <SearchOutlined />
              <input
                aria-label="搜索 Agent 模板"
                value={inviteQuery}
                onChange={(e) => setInviteQuery(e.target.value)}
                placeholder="搜索模板名称、描述或 ID"
              />
            </div>
            <div className="agentChoiceList">
              {templates.length === 0 && <p className="dialogHint">暂无可用的 Agent 模板</p>}
              {templates.length > 0 && filteredInviteTemplates.length === 0 && (
                <p className="dialogHint">没有匹配的 Agent 模板</p>
              )}
              {filteredInviteTemplates.map((tpl) => {
                const idx = inviteSelection.findIndex((item) => item.templateId === tpl.id);
                const selected = idx >= 0;
                return (
                  <div
                    key={tpl.id}
                    className={`agentChoice ${selected ? "selected" : ""}`}
                  >
                    <button
                      className="agentChoiceMain"
                      type="button"
                      onClick={() =>
                        setInviteSelection((current) =>
                          selected
                            ? current.filter((item) => item.templateId !== tpl.id)
                            : [...current, { templateId: tpl.id, provider: "claude-code", name: tpl.name }],
                        )
                      }
                    >
                      <span className="avatar" style={{ background: agentColor(tpl.id) }}>
                        {initials(tpl.name)}
                      </span>
                      <span>
                        <strong>{tpl.name}</strong>
                        <small>{tpl.description.slice(0, 40)}</small>
                      </span>
                    </button>
                    {selected && (
                      <div className="agentChoiceConfig">
                        <input
                          value={inviteSelection[idx].name}
                          onChange={(e) =>
                            setInviteSelection((current) =>
                              current.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item)),
                            )
                          }
                          placeholder="Agent 名称"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <select
                          value={inviteSelection[idx].provider}
                          onChange={(e) =>
                            setInviteSelection((current) =>
                              current.map((item, i) =>
                                i === idx ? { ...item, provider: e.target.value } : item,
                              ),
                            )
                          }
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="claude-code">claude-code</option>
                          <option value="open-code">open-code</option>
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <footer>
              <button className="ghostButton" type="button" onClick={() => setInviteDialogOpen(false)}>取消</button>
              <button className="primaryButton" type="button" onClick={() => void handleInviteAgent()}>
                邀请加入
              </button>
            </footer>
          </section>
        </div>
      )}

      {deleteConfirmOpen && deleteTarget && (
        <div className="dialogLayer" role="presentation" onMouseDown={() => { setDeleteConfirmOpen(false); setDeleteTarget(null); }}>
          <section
            className="agentDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-agent-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <strong id="delete-agent-title">确认移除</strong>
              </div>
            </header>
            <p className="deleteConfirmText">
              确定要从群聊中移除 <strong>{deleteTarget.name}</strong> 吗？此操作不可撤销。
            </p>
            <footer>
              <button className="ghostButton" type="button" onClick={() => { setDeleteConfirmOpen(false); setDeleteTarget(null); }}>
                取消
              </button>
              <button className="dangerButton" type="button" onClick={() => void handleDeleteAgent()}>
                确认移除
              </button>
            </footer>
          </section>
        </div>
      )}

    </main>
  );
}
