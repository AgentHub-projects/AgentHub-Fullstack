"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentInstanceDto,
  AgentTemplateDto,
  BuildMessageDto,
  CreateSessionAgentRequest,
  HubArtifactDto,
  HubContextSnapshotDto,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubRunDto,
  HubSessionDto,
  SessionDetailDto,
  UpdateAgentRequest,
} from "@agenthub/shared";
import {
  ApiOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileDoneOutlined,
  FileMarkdownOutlined,
  LinkOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  SendOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  artifactContentUrl,
  cancelRun,
  confirmBuild,
  connectHubSocket,
  createAgentTemplate,
  createSession,
  createSessionAgent,
  deleteAgent,
  getSessionDetail,
  listAgents,
  listAgentTemplates,
  listSessions,
  pinSessionMessage,
  sendBuildMessage,
  sendSessionMessage,
  startBuild,
  updateAgent,
  upsertById,
} from "../lib/agenthub-api";

type InspectorTab = "diff" | "artifacts" | "context";
type DiffLineKind = "context" | "add" | "remove" | "meta";

interface DiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface FileTreeRow {
  key: string;
  depth: number;
  label: string;
  kind: "folder" | "file";
  change?: HubFileChangeDto;
}

type ConversationItem =
  | { kind: "message"; id: string; ts: string; message: HubMessageDto }
  | {
      kind: "run";
      id: string;
      ts: string;
      run: HubRunDto;
      events: HubEventDto[];
      messages: HubMessageDto[];
    };

interface AgentReplyBlockModel {
  id: string;
  speakerId?: string | null;
  name: string;
  text: string;
  timestamp: string;
  status?: string;
}

interface MentionMatch {
  start: number;
  end: number;
  query: string;
}

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
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [orchTemplateId, setOrchTemplateId] = useState<string>("");
  const [orchProvider, setOrchProvider] = useState(0);
  const [memberTemplates, setMemberTemplates] = useState<Array<{ templateId: string; provider: number }>>([]);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [agentDialogTab, setAgentDialogTab] = useState<"quick" | "builder">("quick");
  const [quickName, setQuickName] = useState("");
  const [quickDesc, setQuickDesc] = useState("");
  const [quickProvider, setQuickProvider] = useState(0);
  const [quickPrompt, setQuickPrompt] = useState("");
  const [buildId, setBuildId] = useState<string | null>(null);
  const [buildMessages, setBuildMessages] = useState<BuildMessageDto[]>([]);
  const [buildInput, setBuildInput] = useState("");
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildConfirm, setBuildConfirm] = useState<{ name: string; description: string; systemPrompt: string; defaultProvider: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ agentId: string; x: number; y: number } | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentInstanceDto | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteSelection, setInviteSelection] = useState<Array<{ templateId: string; provider: number; name: string }>>([]);
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
    setOrchTemplateId("");
    setOrchProvider(0);
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
    if (!activeSessionId) return;
    const result = await cancelRun(activeSessionId, run.id);
    setNotice(result.ok ? "已请求取消当前 run" : `取消失败：${result.error}`);
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
          <button className="iconButton" type="button" title="新建 Agent 模板" onClick={() => { setAgentDialogTab("quick"); setBuildId(null); setBuildMessages([]); setBuildConfirm(null); setQuickName(""); setQuickDesc(""); setQuickProvider(0); setQuickPrompt(""); setAgentDialogOpen(true); }}>
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
                    setInviteSelection(templates.map((tpl) => ({ templateId: tpl.id, provider: 0, name: tpl.name })));
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
              <button className="ghostButton" type="button" onClick={() => void handleCancel(latestRun)}>
                取消
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
                <select value={orchTemplateId} onChange={(e) => setOrchTemplateId(e.target.value)}>
                  <option value="">默认 Orchestrator</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                  ))}
                </select>
              </label>
              {orchTemplateId && (
                <label>
                  Orchestrator Provider
                  <select value={orchProvider} onChange={(e) => setOrchProvider(Number(e.target.value))}>
                    <option value={0}>claude-code</option>
                    <option value={1}>codex</option>
                    <option value={2}>opencode</option>
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
                        value={memberTemplates.find((m) => m.templateId === tpl.id)?.provider ?? 0}
                        onChange={(e) => {
                          e.stopPropagation();
                          setMemberTemplates((current) =>
                            current.map((m) =>
                              m.templateId === tpl.id ? { ...m, provider: Number(e.target.value) } : m,
                            ),
                          );
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value={0}>claude-code</option>
                        <option value={1}>codex</option>
                        <option value={2}>opencode</option>
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
                  onChange={(e) => setEditTarget({ ...editTarget, provider: Number(e.target.value) })}
                >
                  <option value={0}>claude-code</option>
                  <option value={1}>codex</option>
                  <option value={2}>opencode</option>
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
            className="agentDialog"
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
            <div className="agentChoiceList">
              {templates.length === 0 && <p className="dialogHint">暂无可用的 Agent 模板</p>}
              {templates.map((tpl) => {
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
                            : [...current, { templateId: tpl.id, provider: 0, name: tpl.name }],
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
                                i === idx ? { ...item, provider: Number(e.target.value) } : item,
                              ),
                            )
                          }
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value={0}>claude-code</option>
                          <option value={1}>codex</option>
                          <option value={2}>opencode</option>
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

      {agentDialogOpen && (
        <div className="dialogLayer" role="presentation" onMouseDown={() => setAgentDialogOpen(false)}>
          <section
            className="agentDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-agent-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong id="create-agent-title">新建 Agent 模板</strong>
              </div>
              <div className="dialogTabs">
                <button className={agentDialogTab === "quick" ? "active" : ""} type="button" onClick={() => setAgentDialogTab("quick")}>
                  快速创建
                </button>
                <button className={agentDialogTab === "builder" ? "active" : ""} type="button" onClick={() => setAgentDialogTab("builder")}>
                  对话创建
                </button>
              </div>
            </header>
            {agentDialogTab === "quick" ? (
              <div className="buildForm">
                <label>名称 <input value={quickName} onChange={(e) => setQuickName(e.target.value)} placeholder="如：Python 数据分析 Agent" /></label>
                <label>描述 <textarea value={quickDesc} onChange={(e) => setQuickDesc(e.target.value)} placeholder="简要描述用途和能力" /></label>
                <label>Provider
                  <select value={quickProvider} onChange={(e) => setQuickProvider(Number(e.target.value))}>
                    <option value={0}>claude-code</option>
                    <option value={1}>codex</option>
                    <option value={2}>opencode</option>
                  </select>
                </label>
                <label>System Prompt <textarea value={quickPrompt} onChange={(e) => setQuickPrompt(e.target.value)} placeholder="定义 Agent 的行为和回答风格" rows={4} /></label>
              </div>
            ) : (
              <div className="builderPane">
                <div className="buildMessages">
                  {buildMessages.map((msg) => (
                    <div key={msg.id} className={`buildMsg ${msg.role}`}>
                      <RichText text={msg.content} />
                    </div>
                  ))}
                </div>
                {buildConfirm && (
                  <div className="buildConfirmCard">
                    <strong>确认模板</strong>
                    <label>名称 <input value={buildConfirm.name} onChange={(e) => setBuildConfirm({ ...buildConfirm, name: e.target.value })} /></label>
                    <label>描述 <input value={buildConfirm.description} onChange={(e) => setBuildConfirm({ ...buildConfirm, description: e.target.value })} /></label>
                    <label>Provider
                      <select value={buildConfirm.defaultProvider} onChange={(e) => setBuildConfirm({ ...buildConfirm, defaultProvider: Number(e.target.value) })}>
                        <option value={0}>claude-code</option>
                        <option value={1}>codex</option>
                        <option value={2}>opencode</option>
                      </select>
                    </label>
                    <label>System Prompt <textarea value={buildConfirm.systemPrompt} onChange={(e) => setBuildConfirm({ ...buildConfirm, systemPrompt: e.target.value })} rows={4} /></label>
                    <button className="primaryButton" type="button" disabled={buildBusy} onClick={() => void confirmBuild(buildId!, buildConfirm).then(async (res) => {
                      if (res.ok) { setNotice(`模板 "${res.data.template.name}" 创建成功`); setTemplates((c) => [...c, res.data.template]); setAgentDialogOpen(false); }
                      else setNotice(`创建失败：${res.error}`);
                    })}>
                      确认创建
                    </button>
                  </div>
                )}
                <div className="builderInput">
                  <input
                    value={buildInput}
                    onChange={(e) => setBuildInput(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && buildInput.trim() && !buildBusy) {
                        const text = buildInput.trim();
                        setBuildInput("");
                        setBuildBusy(true);
                        try {
                          if (!buildId) {
                            const res = await startBuild({ description: text });
                            if (res.ok) {
                              setBuildId(res.data.buildId);
                              setBuildMessages([res.data.message]);
                            } else setNotice(`Builder 错误：${res.error}`);
                          } else {
                            const res = await sendBuildMessage(buildId, { message: text });
                            if (res.ok) {
                              setBuildMessages((c) => [...c, res.data.message]);
                              const ctx = res.data.context as Record<string, unknown>;
                              if (ctx.name || ctx.description || ctx.systemPrompt) {
                                setBuildConfirm({
                                  name: (ctx.name as string) ?? "",
                                  description: (ctx.description as string) ?? "",
                                  systemPrompt: (ctx.systemPrompt as string) ?? "",
                                  defaultProvider: (ctx.defaultProvider as number) ?? 0,
                                });
                              }
                            } else setNotice(`Builder 错误：${res.error}`);
                          }
                        } finally { setBuildBusy(false); }
                      }
                    }}
                    placeholder="描述你想要的 Agent..."
                    disabled={buildBusy}
                  />
                  {buildBusy && <LoadingOutlined />}
                </div>
              </div>
            )}
            <footer>
              <button className="ghostButton" type="button" onClick={() => {
                setAgentDialogOpen(false); setBuildId(null); setBuildMessages([]); setBuildConfirm(null);
                setQuickName(""); setQuickDesc(""); setQuickProvider(0); setQuickPrompt("");
              }}>取消</button>
              {agentDialogTab === "quick" && (
                <button className="primaryButton" type="button" disabled={!quickName.trim()} onClick={async () => {
                  const res = await createAgentTemplate({ name: quickName, description: quickDesc, defaultProvider: quickProvider, systemPrompt: quickPrompt });
                  if (res.ok) { setNotice(`模板 "${res.data.name}" 创建成功`); setTemplates((c) => [...c, res.data]); setAgentDialogOpen(false); }
                  else setNotice(`创建失败：${res.error}`);
                }}>创建模板</button>
              )}
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

function TimelineMessage({
  message,
  onPin,
  agents,
}: {
  message: HubMessageDto;
  onPin: (message: HubMessageDto) => void;
  agents: AgentInstanceDto[];
}) {
  if (message.role === "user") return <UserMessage message={message} onPin={onPin} />;
  const agent = agents.find((item) => item.id === message.agentId);
  return (
    <AgentReplyBlock
      block={{
        id: message.id,
        speakerId: message.agentId,
        name: message.agentName ?? agent?.name ?? "Agent",
        text: message.contentText,
        timestamp: message.createdAt,
        status: message.status,
      }}
    />
  );
}

function UserMessage({ message, onPin }: { message: HubMessageDto; onPin: (message: HubMessageDto) => void }) {
  return (
    <article className="timelineRow userRow">
      <div className="bubble userBubble">
        <div className="bubbleMeta">
          <span>你 · {formatTime(message.createdAt)}</span>
          <button type="button" title={message.isPinned ? "取消 Pin" : "Pin 到上下文"} onClick={() => onPin(message)}>
            {message.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
          </button>
        </div>
        <RichText text={message.contentText} />
      </div>
    </article>
  );
}

function RunThread({
  run,
  events,
  messages,
  agents,
}: {
  run: HubRunDto;
  events: HubEventDto[];
  messages: HubMessageDto[];
  agents: AgentInstanceDto[];
}) {
  const persistedReplies = messages.filter((message) => message.role !== "user" && message.contentText.trim());
  const hasPersistedReplies = persistedReplies.length > 0 && !isRunning(run.status);
  const replyBlocks = hasPersistedReplies
    ? persistedReplies.map((message) => {
        const agent = agents.find((item) => item.id === message.agentId);
        return {
          id: message.id,
          speakerId: message.agentId,
          name: message.agentName ?? agent?.name ?? "Agent",
          text: message.contentText,
          timestamp: message.createdAt,
          status: message.status,
        };
      })
    : buildAgentReplyBlocks(events, agents);
  const activityEvents = events.filter((event) => event.eventType !== "message.delta");

  return (
    <section className="runThread">
      <div className="runThreadTop">
        <span>Run · {formatTime(run.createdAt)}</span>
        <RunBadge run={run} />
      </div>
      {replyBlocks.map((block) => (
        <AgentReplyBlock key={block.id} block={block} />
      ))}
      {activityEvents.length > 0 && <RunActivityTimeline events={activityEvents} defaultOpen={isRunning(run.status)} />}
      {isRunning(run.status) && <RunStatusPill run={run} events={events} />}
      {run.status === "failed" && <RunFailureBlock run={run} events={events} />}
    </section>
  );
}

function AgentReplyBlock({ block }: { block: AgentReplyBlockModel }) {
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
        </div>
        <RichText text={block.text} />
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

function buildConversationItems(detail: SessionDetailDto | null): ConversationItem[] {
  if (!detail) return [];

  const messages = [...detail.messages].sort(sortMessage);
  const runs = [...detail.runs].sort(sortRun);
  const eventsByRun = new Map<string, HubEventDto[]>();
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const claimedMessageIds = new Set<string>();
  const items: ConversationItem[] = [];

  for (const event of detail.events) {
    const current = eventsByRun.get(event.runId) ?? [];
    current.push(event);
    eventsByRun.set(event.runId, current);
  }

  for (const run of runs) {
    const associatedMessages = messages.filter((message) => message.runId === run.id);
    const userMessage =
      (run.userMessageId ? messagesById.get(run.userMessageId) : undefined) ??
      associatedMessages.find((message) => message.role === "user");
    const runMessages = associatedMessages.filter((message) => message.id !== userMessage?.id);
    const runEvents = [...(eventsByRun.get(run.id) ?? [])].sort(sortEvent);
    const shouldShowRun = runMessages.length > 0 || runEvents.length > 0 || isRunning(run.status) || run.status === "failed";

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

function buildAgentReplyBlocks(events: HubEventDto[], agents: AgentInstanceDto[]): AgentReplyBlockModel[] {
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

function resolveSpeaker(event: HubEventDto, agents: AgentInstanceDto[]) {
  const payloadSpeaker = typeof event.payload.speaker === "string" ? event.payload.speaker : null;
  const speakerId = event.speakerAgentId ?? payloadSpeaker;
  const agent = speakerId ? agents.find((item) => item.id === speakerId) : undefined;
  return {
    speakerId,
    name: event.speakerName ?? agent?.name ?? "Orchestrator",
  };
}

function runStageLabel(run: HubRunDto, events: HubEventDto[]) {
  if (run.status === "queued") return "等待调度";
  if (run.status === "context_building") return "构建上下文";
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

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function formatElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function DiffPanel({ changes }: { changes: HubFileChangeDto[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (changes.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !changes.some((change) => change.id === selectedId)) {
      setSelectedId(changes[0].id);
    }
  }, [changes, selectedId]);

  if (changes.length === 0) return <PanelEmpty icon={<BranchesOutlined />} text="暂无文件变更" />;
  const activeChange = changes.find((change) => change.id === selectedId) ?? changes[0];
  const rows = buildFileTreeRows(changes);
  const additions = countChangeLines(activeChange, "add");
  const deletions = countChangeLines(activeChange, "remove");

  return (
    <div className="panelScroll diffPanelLayout">
      <section className="diffFileTree" aria-label="文件变更树">
        <div className="diffPanelHeader">
          <strong>Files</strong>
          <span>{changes.length}</span>
        </div>
        <div className="diffTreeRows">
          {rows.map((row) =>
            row.kind === "folder" ? (
              <div className="diffTreeFolder" key={row.key} style={{ paddingLeft: 10 + row.depth * 14 }}>
                {row.label}
              </div>
            ) : (
              <button
                className={`diffTreeFile ${row.change?.id === activeChange.id ? "active" : ""}`}
                key={row.key}
                type="button"
                onClick={() => row.change && setSelectedId(row.change.id)}
                style={{ paddingLeft: 10 + row.depth * 14 }}
              >
                <span>{row.label}</span>
                <code>{row.change?.changeType}</code>
              </button>
            ),
          )}
        </div>
      </section>

      <section className="diffViewerCard">
        <div className="diffViewerTop">
          <div>
            <strong>{activeChange.path}</strong>
            {activeChange.oldPath && <small>{activeChange.oldPath}</small>}
          </div>
          <span className={`changeType ${activeChange.changeType}`}>{activeChange.changeType}</span>
        </div>
        <div className="diffStats">
          <span className="add">+{additions}</span>
          <span className="remove">-{deletions}</span>
          {activeChange.afterTruncated || activeChange.beforeTruncated ? <span>内容已截断</span> : null}
        </div>
        <UnifiedDiffView change={activeChange} />
      </section>
    </div>
  );
}

function ArtifactPanel({ artifacts }: { artifacts: HubArtifactDto[] }) {
  if (artifacts.length === 0) return <PanelEmpty icon={<FileDoneOutlined />} text="暂无 artifact" />;
  return (
    <div className="panelScroll">
      {artifacts.map((artifact) => (
        <article className="artifactBlock" key={artifact.id}>
          <div className="artifactTop">
            <span>{artifactIcon(artifact.kind)}</span>
            <div>
              <strong>{artifact.title}</strong>
              <small>{artifact.kind} · {artifact.mimeType} · v{artifact.version} · {artifact.final ? "final" : "draft"}</small>
            </div>
            <a title="打开内容" href={artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
              <LinkOutlined />
            </a>
          </div>
          <ArtifactPreview artifact={artifact} />
        </article>
      ))}
    </div>
  );
}

function ContextPanel({
  context,
  agents,
  templates,
}: {
  context: HubContextSnapshotDto | null;
  agents: AgentInstanceDto[];
  templates: AgentTemplateDto[];
}) {
  if (!context) return <PanelEmpty icon={<DatabaseOutlined />} text="暂无上下文快照" />;
  const payload = context.snapshotJson;
  return (
    <div className="panelScroll contextPanel">
      <div className="contextSummary">
        <strong>Snapshot v{context.version}</strong>
        <span>{context.tokenCount}/{context.tokenBudget} tokens</span>
      </div>
      <ContextSection title="Pin" items={payload.pins} />
      <ContextSection title="Recent" items={payload.recent} />
      <ContextSection title="pgvector Recall" items={payload.retrieved} />
      <section className="agentMatrix">
        <strong>Agent 实例</strong>
        {agents.map((agent) => (
          <div key={agent.id}>
            <span>{agent.name}</span>
            <code>{agent.template?.name ?? "worker"}</code>
          </div>
        ))}
        <strong>模板</strong>
        {templates.map((template) => (
          <div key={template.id}>
            <span>{template.name}</span>
            <code>provider: {template.defaultProvider}</code>
          </div>
        ))}
      </section>
    </div>
  );
}

function ContextSection({ title, items }: { title: string; items: HubContextSnapshotDto["snapshotJson"]["pins"] }) {
  return (
    <section className="contextSection">
      <div className="contextSectionTitle">
        <strong>{title}</strong>
        <span>{items.length}</span>
      </div>
      {items.map((item) => (
        <p key={item.id}>
          <code>{item.kind}</code>
          {item.text}
        </p>
      ))}
    </section>
  );
}

function InlineDiff({ event }: { event: HubEventDto }) {
  const patch = typeof event.payload.patch === "string" ? event.payload.patch : "";
  const path = typeof event.payload.path === "string" ? event.payload.path : "changed file";
  return (
    <div className="inlineArtifact">
      <strong><CodeOutlined /> {path}</strong>
      {patch ? <UnifiedDiffLines lines={parseUnifiedPatch(patch)} /> : <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
    </div>
  );
}

function InlineArtifact({ event }: { event: HubEventDto }) {
  const title = typeof event.payload.title === "string" ? event.payload.title : "Artifact";
  const content = typeof event.payload.content === "string" ? event.payload.content : "";
  return (
    <div className="inlineArtifact">
      <strong><FileMarkdownOutlined /> {title}</strong>
      {content ? <RichText text={content} /> : <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
    </div>
  );
}

function ArtifactPreview({ artifact }: { artifact: HubArtifactDto }) {
  const contentUrl = artifactContentUrl(artifact.id);
  if (artifact.kind === "image") {
    return (
      <div className="mediaPreview">
        <img alt={artifact.title} src={contentUrl} />
      </div>
    );
  }

  if (artifact.kind === "pdf") {
    return <iframe className="documentFrame" title={artifact.title} src={contentUrl} />;
  }

  if (artifact.kind === "html" && artifact.textContent) {
    return <iframe className="documentFrame" title={artifact.title} srcDoc={artifact.textContent} sandbox="" />;
  }

  if (artifact.kind === "docx") {
    return (
      <div className="documentFallback">
        <FileDoneOutlined />
        <div>
          <strong>DOCX 原始文件</strong>
          <span>后端当前提供只读下载入口；接入 HTML render 后可在此处内联预览。</span>
        </div>
      </div>
    );
  }

  if (artifact.textContent) {
    return artifact.kind === "log" ? <pre>{artifact.textContent}</pre> : <RichText text={artifact.textContent} />;
  }

  return <code>{artifact.storageUri ?? "inline artifact"}</code>;
}

function RichText({ text }: { text: string }) {
  if (!text) return null;
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="richText">
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

function UnifiedDiffView({ change }: { change: HubFileChangeDto }) {
  return <UnifiedDiffLines lines={buildDiffLines(change)} />;
}

function UnifiedDiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="unifiedDiff" role="table">
      {lines.map((line, index) => (
        <div className={`diffLine ${line.kind}`} key={`${index}-${line.oldLine ?? "x"}-${line.newLine ?? "x"}`} role="row">
          <span className="lineNo">{line.oldLine ?? ""}</span>
          <span className="lineNo">{line.newLine ?? ""}</span>
          <span className="lineMarker">{diffMarker(line.kind)}</span>
          <code>{line.text || " "}</code>
        </div>
      ))}
    </div>
  );
}

type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push({ kind: "code", language: fence[1] ?? "", text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index++;
      continue;
    }

    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index++;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index++;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !lines[index].startsWith(">") &&
      !isTableStart(lines, index)
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): React.ReactNode {
  if (block.kind === "heading") {
    const Tag = block.level <= 1 ? "h2" : "h3";
    return <Tag key={index}>{block.text}</Tag>;
  }
  if (block.kind === "code") {
    return (
      <div className="codeBlock" key={index}>
        {block.language && <span>{block.language}</span>}
        <pre>{block.text}</pre>
      </div>
    );
  }
  if (block.kind === "ul") {
    return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>;
  }
  if (block.kind === "ol") {
    return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>;
  }
  if (block.kind === "quote") {
    return <blockquote key={index}>{block.text}</blockquote>;
  }
  if (block.kind === "table") {
    return (
      <div className="markdownTableWrap" key={index}>
        <table>
          <thead>
            <tr>{block.headers.map((header, cellIndex) => <th key={cellIndex}>{header}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.headers.map((_, cellIndex) => <td key={cellIndex}>{row[cellIndex] ?? ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <p key={index}>{block.text}</p>;
}

function isTableStart(lines: string[], index: number) {
  return Boolean(
    lines[index]?.includes("|") &&
      lines[index + 1] &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]),
  );
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function buildFileTreeRows(changes: HubFileChangeDto[]): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const seenFolders = new Set<string>();
  const sorted = [...changes].sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)));

  for (const change of sorted) {
    const parts = normalizePath(change.path).split("/").filter(Boolean);
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const key = parts.slice(0, depth + 1).join("/");
      if (!seenFolders.has(key)) {
        seenFolders.add(key);
        rows.push({ key, depth, label: parts[depth], kind: "folder" });
      }
    }
    rows.push({
      key: change.id,
      depth: Math.max(0, parts.length - 1),
      label: parts.at(-1) ?? change.path,
      kind: "file",
      change,
    });
  }

  return rows;
}

function buildDiffLines(change: HubFileChangeDto): DiffLine[] {
  if (change.patch?.trim()) return parseUnifiedPatch(change.patch);
  return diffText(change.beforeContent ?? "", change.afterContent ?? "");
}

function parseUnifiedPatch(patch: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      result.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff --git") || raw.startsWith("index ")) {
      result.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      result.push({ kind: "add", newLine: newLine++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      result.push({ kind: "remove", oldLine: oldLine++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("\\")) {
      result.push({ kind: "meta", text: raw });
      continue;
    }
    result.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }

  return result;
}

function diffText(before: string, after: string): DiffLine[] {
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  if (beforeLines.length === 0 && afterLines.length === 0) return [{ kind: "context", text: "" }];
  if (beforeLines.length * afterLines.length > 20000) {
    return [
      ...beforeLines.map((text, index) => ({ kind: "remove" as const, oldLine: index + 1, text })),
      ...afterLines.map((text, index) => ({ kind: "add" as const, newLine: index + 1, text })),
    ];
  }

  const matrix = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0) as number[]);
  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      matrix[i][j] = beforeLines[i] === afterLines[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < beforeLines.length || newIndex < afterLines.length) {
    if (oldIndex < beforeLines.length && newIndex < afterLines.length && beforeLines[oldIndex] === afterLines[newIndex]) {
      lines.push({ kind: "context", oldLine: oldIndex + 1, newLine: newIndex + 1, text: beforeLines[oldIndex] });
      oldIndex++;
      newIndex++;
    } else if (newIndex < afterLines.length && (oldIndex === beforeLines.length || matrix[oldIndex][newIndex + 1] >= matrix[oldIndex + 1][newIndex])) {
      lines.push({ kind: "add", newLine: newIndex + 1, text: afterLines[newIndex] });
      newIndex++;
    } else if (oldIndex < beforeLines.length) {
      lines.push({ kind: "remove", oldLine: oldIndex + 1, text: beforeLines[oldIndex] });
      oldIndex++;
    }
  }
  return lines;
}

function splitLinesForDiff(text: string) {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function countChangeLines(change: HubFileChangeDto, kind: "add" | "remove") {
  const value = change.stats[kind === "add" ? "additions" : "deletions"];
  if (typeof value === "number") return value;
  return buildDiffLines(change).filter((line) => line.kind === kind).length;
}

function diffMarker(kind: DiffLineKind) {
  if (kind === "add") return "+";
  if (kind === "remove") return "-";
  if (kind === "meta") return "";
  return " ";
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

function RunBadge({ run }: { run: HubRunDto }) {
  return (
    <div className={`runBadge ${run.status}`}>
      {isRunning(run.status) ? <LoadingOutlined /> : run.status === "completed" ? <CheckCircleOutlined /> : <MessageOutlined />}
      <span>{run.status}</span>
    </div>
  );
}

function PanelEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="panelEmpty">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function eventText(event: HubEventDto) {
  const value = event.payload.text ?? event.payload.content ?? event.payload.message ?? event.payload.delta ?? event.payload.status;
  return typeof value === "string" ? value : JSON.stringify(event.payload, null, 2);
}

function findActiveMention(text: string, caret: number): MentionMatch | null {
  const beforeCaret = text.slice(0, caret);
  const at = beforeCaret.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(beforeCaret[at - 1])) return null;

  const query = beforeCaret.slice(at + 1);
  if (!/^[a-zA-Z0-9_-]*$/.test(query)) return null;
  return { start: at, end: caret, query };
}

function filterMentionCandidates(agents: AgentInstanceDto[], query: string) {
  const normalized = query.toLowerCase();
  if (!normalized) return agents;
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().startsWith(normalized) ||
      agent.id.toLowerCase().startsWith(normalized),
  );
}

function parseMentionedAgentIds(text: string, agents: AgentInstanceDto[]) {
  const byToken = new Map<string, string>();
  for (const agent of agents) {
    byToken.set(agent.name.toLowerCase(), agent.id);
    byToken.set(agent.id.toLowerCase(), agent.id);
  }

  const ids = new Set<string>();
  for (const match of text.matchAll(/@([a-zA-Z0-9_-]+)/g)) {
    const id = byToken.get(match[1].toLowerCase());
    if (id) ids.add(id);
  }
  return [...ids];
}

function readMemberAgentIds(session: HubSessionDto | null | undefined) {
  const value = session?.metadata.memberAgentIds;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function buildGroupTitle(templateIds: string[], templates: AgentTemplateDto[]) {
  const names = templateIds
    .map((id) => templates.find((tpl) => tpl.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return "新 Agent 群聊";
  return `Agent 群聊 · ${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 个` : ""}`;
}

function sessionSubtitle(session: HubSessionDto) {
  const memberCount = readMemberAgentIds(session).length;
  const status = session.lastRun?.status ?? session.status;
  return `${memberCount ? `${memberCount} 个 Agent · ` : ""}${status} · ${formatTime(session.updatedAt)}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || "AI";
}

function agentColor(seed: string) {
  const colors = ["#2c6d67", "#365f91", "#8a5b2c", "#7d476d", "#56633f", "#8a3f3f"];
  let hash = 0;
  for (const char of seed) hash = char.charCodeAt(0) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function artifactIcon(kind: HubArtifactDto["kind"]) {
  if (kind === "markdown" || kind === "text") return <FileMarkdownOutlined />;
  if (kind === "pdf" || kind === "docx") return <FileDoneOutlined />;
  return <CodeOutlined />;
}

function isRunning(status: string) {
  return status === "queued" || status === "context_building" || status === "connecting" || status === "running";
}

function sortSession(a: HubSessionDto, b: HubSessionDto) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function sortMessage(a: HubMessageDto, b: HubMessageDto) {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function sortRun(a: HubRunDto, b: HubRunDto) {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function sortEvent(a: HubEventDto, b: HubEventDto) {
  return a.seq - b.seq || new Date(a.persistedAt).getTime() - new Date(b.persistedAt).getTime();
}

function sortArtifact(a: HubArtifactDto, b: HubArtifactDto) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function sortFileChange(a: HubFileChangeDto, b: HubFileChangeDto) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
