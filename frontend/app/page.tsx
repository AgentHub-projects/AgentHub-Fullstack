"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentInstanceDto,
  AgentTemplateDto,
  CreateSessionAgentRequest,
  HubMessageDto,
  HubRunDto,
  HubSessionDto,
  SessionDetailDto,
  UpdateAgentRequest,
} from "@agenthub/shared";
import {
  BranchesOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileDoneOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  SendOutlined,
  SearchOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  cancelRun,
  connectHubSocket,
  createSession,
  createSessionAgent,
  deleteAgent,
  getSessionDetail,
  listAgents,
  listAgentTemplates,
  listSessions,
  pinSessionMessage,
  sendSessionMessage,
  updateAgent,
  upsertById,
} from "../lib/agenthub-api";
import { ArtifactPanel, ContextPanel, DiffPanel } from "./workbench/inspector";
import { RunBadge, RunThread, TimelineMessage } from "./workbench/timeline";
import {
  agentColor,
  buildGroupTitle,
  initials,
  isRunning,
  readMemberAgentIds,
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
  context: null,
};

export default function WorkbenchPage() {
  const [sessions, setSessions] = useState<HubSessionDto[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetailDto | null>(null);
  const [agents, setAgents] = useState<AgentInstanceDto[]>([]);
  const [templates, setTemplates] = useState<AgentTemplateDto[]>([]);
  const [composer, setComposer] = useState("");
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("diff");
  const [notice, setNotice] = useState("正在连接 AgentHub 后端");
  const [sending, setSending] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [orchTemplateId, setOrchTemplateId] = useState<number>(0);
  const [orchProvider, setOrchProvider] = useState("claude-code");
  const [memberTemplates, setMemberTemplates] = useState<Array<{ templateId: number; provider: string }>>([]);
  const [contextMenu, setContextMenu] = useState<{ agentId: number; x: number; y: number } | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentInstanceDto | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteSelection, setInviteSelection] = useState<Array<{ templateId: number; provider: string; name: string }>>([]);
  const [inviteQuery, setInviteQuery] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentInstanceDto | null>(null);
  const [groupMembersExpanded, setGroupMembersExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const activeSession = detail?.session ?? sessions.find((session) => session.id === activeSessionId) ?? null;
  const latestRun = detail?.runs.at(-1) ?? activeSession?.lastRun ?? null;
  const orchestrator = agents.find((agent) => agent.isDefaultOrchestrator) ?? agents[0] ?? null;
  const workerAgents = agents.filter((agent) => !agent.isDefaultOrchestrator);
  const activeGroupMemberIds = useMemo(() => readMemberAgentIds(activeSession), [activeSession]);
  const activeGroupMembers = workerAgents.filter((agent) => activeGroupMemberIds.includes(agent.id));
  const composerAgents = activeGroupMemberIds.length > 0 ? activeGroupMembers : workerAgents;
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
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
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
      onContext: (context) => {
        setDetail((current) => (current ? { ...current, context } : current));
      },
    });
    return disconnect;
  }, [activeSessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [conversationItems.length, detail?.events.length]);

  useEffect(() => {
    if (activeMentionIndex >= mentionCandidates.length) {
      setActiveMentionIndex(0);
    }
  }, [activeMentionIndex, mentionCandidates.length]);

  async function bootstrap() {
    const [agentRes, templateRes, sessionRes] = await Promise.all([listAgents(), listAgentTemplates(), listSessions()]);
    if (agentRes.ok) setAgents(agentRes.data.items);
    if (templateRes.ok) setTemplates(templateRes.data);

    if (!sessionRes.ok) {
      setNotice(`后端不可用：${sessionRes.error}`);
      return;
    }

    let items = sessionRes.data.items;
    if (items.length === 0) {
      const created = await createSession({ title: "AgentHub 群聊" });
      if (created.ok) items = [created.data];
    }
    setSessions(items);
    const selected = items[0]?.id ?? null;
    setActiveSessionId(selected);
    if (selected) await loadSession(selected);
  }

  async function loadSession(sessionId: string) {
    setActiveSessionId(sessionId);
    const result = await getSessionDetail(sessionId);
    if (!result.ok) {
      setNotice(`会话加载失败：${result.error}`);
      return;
    }
    setDetail(result.data);
    closeMentionMenu();
  }

  function openCreateGroupDialog() {
    setGroupTitle("");
    setOrchTemplateId(0);
    setOrchProvider("claude-code");
    setMemberTemplates([]);
    setGroupDialogOpen(true);
  }

  async function handleCreateGroup() {
    const result = await createSession({
      title: groupTitle.trim() || buildGroupTitle(memberTemplates.map((m) => m.templateId), templates),
      orchestratorTemplateId: orchTemplateId || undefined,
      orchestratorProvider: orchProvider,
      memberTemplates: memberTemplates.length > 0 ? memberTemplates : undefined,
    });
    if (!result.ok) {
      setNotice(`创建失败：${result.error}`);
      return;
    }
    setSessions((current) => [result.data, ...current]);
    setDetail({ session: result.data, ...EMPTY_DETAIL });
    setActiveSessionId(result.data.id);
    closeMentionMenu();
    setGroupDialogOpen(false);
  }

  async function handleSend() {
    const text = composer.trim();
    if (!text || !activeSessionId || sending) return;
    setSending(true);
    setComposer("");
    closeMentionMenu();
    try {
      const targetAgentIds = parsedMentionIds.length > 0 ? parsedMentionIds : composerAgents.map((agent) => agent.id);
      const result = await sendSessionMessage(activeSessionId, {
        content: text,
        mentionedAgentIds: targetAgentIds,
        orchestratorAgentId: orchestrator?.id,
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
          context: result.data.contextSnapshot,
        };
      });
      setSessions((current) => upsertById(current, result.data.session).sort(sortSession));
      setNotice("消息已发送给主 Orchestrator");
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
          <button className="iconButton" type="button" title="新建群聊" onClick={openCreateGroupDialog}>
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
              <strong>群聊成员</strong>
              <span>{composerAgents.length ? `${composerAgents.length} 个 Agent` : "未选择成员"}</span>
            </button>
            {groupMembersExpanded && (
              <div className="memberList">
                {(orchestrator ? [orchestrator] : []).concat(
                  activeGroupMemberIds.length > 0 ? activeGroupMembers : workerAgents
                ).map((agent) => (
                  <div
                    key={agent.id}
                    className="memberRow"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ agentId: agent.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="avatar" style={{ background: agentColor(agent.id) }}>
                      {initials(agent.name)}
                    </span>
                    <span className="memberName">{agent.name}</span>
                    {agent.isDefaultOrchestrator && <span className="memberOrchTag">协调者</span>}
                  </div>
                ))}
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
              </div>
            )}
          </section>
        </div>

        <nav className="sessionList" aria-label="会话">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`sessionItem ${session.id === activeSessionId ? "active" : ""}`}
              type="button"
              onClick={() => void loadSession(session.id)}
            >
              <span>{session.title}</span>
              <small>{sessionSubtitle(session)}</small>
            </button>
          ))}
        </nav>
      </aside>

      <section className="conversationPane">
        <header className="conversationHeader">
          <div>
            <strong>{activeSession?.title ?? "AgentHub 群聊"}</strong>
            <span>{notice}</span>
          </div>
          <div className="headerActions">
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
              placeholder="输入任务，使用 @frontend-agent 指定群聊成员"
              disabled={sending || !activeSessionId}
            />
          </div>
          <div className="composerBar">
            <span>
              {parsedMentionIds.length
                ? `将发送给 ${parsedMentionIds.length} 个 Agent`
                : composerAgents.length
                  ? `群聊成员 ${composerAgents.length} 个 Agent`
                  : "默认由主 Orchestrator 协调"}
            </span>
            <button className="primaryButton" type="button" disabled={!composer.trim() || sending} onClick={() => void handleSend()}>
              {sending ? <LoadingOutlined /> : <SendOutlined />}
              <span>发送</span>
            </button>
          </div>
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
          <button
            className={inspectorTab === "context" ? "active" : ""}
            type="button"
            onClick={() => setInspectorTab("context")}
          >
            <DatabaseOutlined />
            <span>Context</span>
          </button>
        </div>

        {!inspectorCollapsed && (
          <>
            {inspectorTab === "diff" && <DiffPanel changes={detail?.fileChanges ?? []} />}
            {inspectorTab === "artifacts" && <ArtifactPanel artifacts={detail?.artifacts ?? []} />}
            {inspectorTab === "context" && (
              <ContextPanel context={detail?.context ?? null} templates={templates} agents={agents} />
            )}
          </>
        )}
      </aside>

      {groupDialogOpen && (
        <div className="dialogLayer" role="presentation" onMouseDown={() => setGroupDialogOpen(false)}>
          <section
            className="groupDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-group-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong id="create-group-title">新建群聊</strong>
                <span>填写群聊信息并选择模板</span>
              </div>
            </header>
            <div className="buildForm">
              <label>
                群聊名称
                <input value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} placeholder="输入群聊名称" />
              </label>
              <label>
                Orchestrator 模板
                <select value={orchTemplateId} onChange={(e) => setOrchTemplateId(Number(e.target.value))}>
                  <option value="">默认 Orchestrator</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                  ))}
                </select>
              </label>
              {orchTemplateId && (
                <label>
                  Orchestrator Provider
                  <select value={orchProvider} onChange={(e) => setOrchProvider(e.target.value)}>
                    <option value="claude-code">claude-code</option>
                    <option value="open-code">open-code</option>
                  </select>
                </label>
              )}
              <label>群成员模板（多选）</label>
            </div>
            <div className="agentChoiceList">
              {templates.length === 0 && <p className="dialogHint">暂无可用的 Agent 模板，请先创建模板。</p>}
              {templates.map((tpl) => {
                const selected = memberTemplates.some((m) => m.templateId === tpl.id);
                return (
                  <button
                    key={tpl.id}
                    className={`agentChoice ${selected ? "selected" : ""}`}
                    type="button"
                    onClick={() =>
                      setMemberTemplates((current) =>
                        selected
                          ? current.filter((m) => m.templateId !== tpl.id)
                          : [...current, { templateId: tpl.id, provider: tpl.defaultProvider }],
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
                    {selected && (
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
                    )}
                  </button>
                );
              })}
            </div>
            <footer>
              <button className="ghostButton" type="button" onClick={() => setGroupDialogOpen(false)}>
                取消
              </button>
              <button className="primaryButton" type="button" onClick={() => void handleCreateGroup()}>
                创建群聊
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
