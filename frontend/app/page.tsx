"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type SetStateAction, type UIEvent } from "react";
import type {
  AgentInstanceDto,
  AgentTemplateDto,
  AuthUserDto,
  CreateSessionAgentRequest,
  DeploymentPreflightResponse,
  HubArtifactDto,
  HubMessageDto,
  HubMessagePartDto,
  HubRunDto,
  HubSessionDto,
  ProjectDto,
  SessionDetailDto,
  SessionTimelinePageDto,
  UpdateAgentRequest,
  UploadedAttachmentDto,
} from "@agenthub/shared";
import {
  BranchesOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileDoneOutlined,
  FileOutlined,
  InboxOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PaperClipOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  RobotOutlined,
  RocketOutlined,
  SendOutlined,
  SearchOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  archiveSession,
  bindSessionProject,
  cancelRun,
  connectHubSocket,
  createSession,
  createProject,
  createSessionAgent,
  deleteAgent,
  getAuthState,
  getDeploymentPreflight,
  getSessionDetail,
  listAgents,
  listAgentTemplates,
  listPinnedMessages,
  listProjects,
  listSessions,
  listSessionArtifacts,
  listSessionFileChanges,
  listSessionTimeline,
  loginWithCredentials,
  pinSessionMessage,
  regenerateSessionMessage,
  sendSessionMessage,
  startDeployment,
  uploadSessionAttachment,
  updateCurrentUser,
  uploadAvatar,
  updateSession,
  updateAgent,
  upsertById,
} from "../lib/agenthub-api";
import { AvatarFace } from "./workbench/avatar";
import { ArtifactPanel, ArtifactViewerLayer, FilePanel, MainGitDiffPanel } from "./workbench/inspector";
import { MessagePartViewerLayer } from "./workbench/rich-text";
import { RunBadge, RunThread, TimelineMessage } from "./workbench/timeline";
import {
  agentColor,
  formatTime,
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
import {
  EMPTY_SESSION_TABS,
  activateSessionTab,
  closeSessionTab,
  markSessionTabUpdated,
  openSessionTab,
} from "../lib/workbench/session-tabs";
import { buildConversationItems } from "../lib/workbench/timeline";
import type { InspectorTab, MentionMatch } from "../lib/workbench/types";
import { formatBytes } from "../lib/utils";

const EMPTY_DETAIL: Omit<SessionDetailDto, "session"> = {
  messages: [],
  runs: [],
  events: [],
  artifacts: [],
  fileChanges: [],
};

type ReplyTarget = {
  message: HubMessageDto;
  partId?: string;
  preview: string;
};

type SessionWorkspace = {
  detail: SessionDetailDto | null;
  composer: string;
  attachments: UploadedAttachmentDto[];
  replyTargets: ReplyTarget[];
  inspectorTab: InspectorTab;
  timelineHasMore: boolean;
  timelineCursor: string | null;
  timelineLoadingOlder: boolean;
};

const EMPTY_WORKSPACE: SessionWorkspace = {
  detail: null,
  composer: "",
  attachments: [],
  replyTargets: [],
  inspectorTab: "diff",
  timelineHasMore: false,
  timelineCursor: null,
  timelineLoadingOlder: false,
};

const PAGE_SIZE = 10;
const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const AVATAR_TYPES = new Set(AVATAR_ACCEPT.split(","));

export default function WorkbenchPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthUserDto | null>(null);
  const [authUsername, setAuthUsername] = useState("admin");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [sessions, setSessions] = useState<HubSessionDto[]>([]);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsNextCursor, setSessionsNextCursor] = useState<string | null>(null);
  const [sessionsLoadingInitial, setSessionsLoadingInitial] = useState(false);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionActionId, setSessionActionId] = useState<string | null>(null);
  const [sessionTabs, setSessionTabs] = useState(EMPTY_SESSION_TABS);
  const [workspaces, setWorkspaces] = useState<Record<string, SessionWorkspace>>({});
  const [agents, setAgents] = useState<AgentInstanceDto[]>([]);
  const [templates, setTemplates] = useState<AgentTemplateDto[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [deploymentPreflights, setDeploymentPreflights] = useState<Record<string, DeploymentPreflightResponse>>({});
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [deployingSessionId, setDeployingSessionId] = useState<string | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [sessionRailCollapsed, setSessionRailCollapsed] = useState(false);
  const [openedFilePath, setOpenedFilePath] = useState<string | null>(null);
  const [mainGitRefreshSignal, setMainGitRefreshSignal] = useState(0);
  const [activeArtifactViewerId, setActiveArtifactViewerId] = useState<string | null>(null);
  const [activePartViewer, setActivePartViewer] = useState<HubMessagePartDto | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [projectGithubUrlDraft, setProjectGithubUrlDraft] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [createMode, setCreateMode] = useState<"direct" | "group">("direct");
  const [directTemplateId, setDirectTemplateId] = useState<number>(0);
  const [directName, setDirectName] = useState("");
  const [directProvider, setDirectProvider] = useState("claude-code");
  const [groupTitle, setGroupTitle] = useState("");
  const [orchTemplateId, setOrchTemplateId] = useState<number>(0);
  const [orchName, setOrchName] = useState("");
  const [orchSearch, setOrchSearch] = useState("");
  const [orchDropdownOpen, setOrchDropdownOpen] = useState(false);
  const [archiveConfirmSession, setArchiveConfirmSession] = useState<HubSessionDto | null>(null);
  const selectedOrchTpl = templates.find((t) => t.id === orchTemplateId);

  function closeGroupDialog() {
    setGroupDialogOpen(false);
    setOrchSearch("");
    setOrchDropdownOpen(false);
  }

  function closeProjectDialog() {
    if (creatingProject) return;
    setProjectDialogOpen(false);
    setProjectNameDraft("");
    setProjectGithubUrlDraft("");
  }
  const [orchProvider, setOrchProvider] = useState("claude-code");
  const [memberTemplates, setMemberTemplates] = useState<Array<{ templateId: number; provider: string; name: string }>>([]);
  const [contextMenu, setContextMenu] = useState<{ agentId: number; x: number; y: number } | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentInstanceDto | null>(null);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<{ displayName: string; avatarUrl: string | null }>({
    displayName: "",
    avatarUrl: null,
  });
  const [profileError, setProfileError] = useState("");
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
  const profileAvatarInputRef = useRef<HTMLInputElement>(null);
  const agentAvatarInputRef = useRef<HTMLInputElement>(null);
  const profileUpdateSeqRef = useRef(0);
  const agentUpdateSeqRef = useRef<Record<number, number>>({});
  const sessionListRequestSeqRef = useRef(0);
  const loadedSessionQueryRef = useRef("");
  const firstDetailMarkedRef = useRef(false);
  const firstRenderMarkedRef = useRef(false);
  const agentsLoadedRef = useRef(false);
  const templatesLoadedRef = useRef(false);
  const projectsLoadedRef = useRef(false);
  const agentsRequestRef = useRef<Promise<void> | null>(null);
  const templatesRequestRef = useRef<Promise<void> | null>(null);
  const projectsRequestRef = useRef<Promise<void> | null>(null);
  const pinnedRequestRef = useRef<Record<string, Promise<void> | undefined>>({});
  const pinnedLoadedRef = useRef<Record<string, boolean>>({});
  const outputsRequestRef = useRef<Record<string, Promise<void> | undefined>>({});
  const outputsLoadedRef = useRef<Record<string, boolean>>({});
  const deploymentPreflightRequestRef = useRef<Record<string, Promise<DeploymentPreflightResponse | null> | undefined>>({});
  const timelineRef = useRef<HTMLDivElement>(null);
  const preserveTimelineScrollRef = useRef<{ height: number; top: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const activeSessionId = sessionTabs.activeId;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const openSessionIds = sessionTabs.openIds;
  const socketSessionIds = openSessionIds.filter((sessionId) => Boolean(workspaces[sessionId]?.detail));
  const socketSessionKey = socketSessionIds.join("|");
  const activeWorkspace = activeSessionId ? workspaces[activeSessionId] : null;
  const detail = activeWorkspace?.detail ?? null;
  const composer = activeWorkspace?.composer ?? "";
  const attachments = activeWorkspace?.attachments ?? [];
  const replyTargets = activeWorkspace?.replyTargets ?? [];
  const inspectorTab = activeWorkspace?.inspectorTab ?? "diff";
  const deploymentPreflight = activeSessionId ? deploymentPreflights[activeSessionId] : undefined;
  const activeSession = detail?.session ?? sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeProject = activeSession?.projectId
    ? (projects.find((project) => project.id === activeSession.projectId) ?? null)
    : null;
  const activeArtifactViewer = activeArtifactViewerId
    ? (detail?.artifacts.find((artifact) => artifact.id === activeArtifactViewerId) ?? null)
    : null;
  const latestRun = detail?.runs.at(-1) ?? activeSession?.lastRun ?? null;
  const sessionWritable = activeSession?.status === "active";
  const activeRunInProgress = isRunning(latestRun?.status ?? "");
  const runActionLocked = !sessionWritable;
  const chatActionLocked = runActionLocked;
  const sandboxEditorDisabledReason = !activeSessionId
    ? "请选择会话后编辑文件"
    : !sessionWritable
        ? "归档会话不能编辑文件"
        : "";
  const inspectorModeClass =
    inspectorTab === "files" ? "filesActive" : inspectorTab === "diff" ? "diffActive" : "artifactsActive";
  const fileEditorOpen = inspectorTab === "files" && !inspectorCollapsed && Boolean(openedFilePath);
  const shouldCollapseSessionRail = !inspectorCollapsed;
  const shellClassName = [
    "agenthubShell",
    inspectorModeClass,
    inspectorCollapsed ? "inspectorCollapsed" : "",
    shouldCollapseSessionRail ? "railCollapsed" : "",
    fileEditorOpen ? "fileEditorOpen" : "",
  ].filter(Boolean).join(" ");
  const memberMutationLocked = !sessionWritable || activeRunInProgress;
  const sessionReadOnly = Boolean(activeSession && activeSession.status !== "active");
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
  const currentUserName = currentUserDisplayName(currentUser);
  const pinnedMessages = useMemo(
    () =>
      [...(detail?.pinnedMessages?.length ? detail.pinnedMessages : (detail?.messages ?? []))]
        .filter(hasPinnedMessageContent)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [detail?.messages, detail?.pinnedMessages],
  );

  function ensureWorkspace(sessionId: string, patch: Partial<SessionWorkspace> = {}) {
    setWorkspaces((current) => ({
      ...current,
      [sessionId]: { ...EMPTY_WORKSPACE, ...current[sessionId], ...patch },
    }));
  }

  function updateWorkspace(sessionId: string, updater: (current: SessionWorkspace) => SessionWorkspace) {
    setWorkspaces((current) => {
      const existing = current[sessionId] ?? EMPTY_WORKSPACE;
      return { ...current, [sessionId]: updater(existing) };
    });
  }

  function updateActiveWorkspace(updater: (current: SessionWorkspace) => SessionWorkspace) {
    if (!activeSessionId) return;
    updateWorkspace(activeSessionId, updater);
  }

  function setActiveSessionId(sessionId: string | null) {
    setSessionTabs((current) => activateSessionTab(current, sessionId));
    if (sessionId) ensureWorkspace(sessionId);
  }

  function closeOpenSession(sessionId: string) {
    setSessionTabs((current) => closeSessionTab(current, sessionId));
    setWorkspaces((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setDeploymentPreflights((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function setDetail(value: SetStateAction<SessionDetailDto | null>) {
    updateActiveWorkspace((current) => ({
      ...current,
      detail: resolveState(value, current.detail),
    }));
  }

  function setWorkspaceDetail(sessionId: string, value: SetStateAction<SessionDetailDto | null>) {
    updateWorkspace(sessionId, (current) => ({
      ...current,
      detail: resolveState(value, current.detail),
    }));
  }

  function setComposer(value: SetStateAction<string>) {
    updateActiveWorkspace((current) => ({ ...current, composer: resolveState(value, current.composer) }));
  }

  function setAttachments(value: SetStateAction<UploadedAttachmentDto[]>) {
    updateActiveWorkspace((current) => ({ ...current, attachments: resolveState(value, current.attachments) }));
  }

  function setReplyTargets(value: SetStateAction<ReplyTarget[]>) {
    updateActiveWorkspace((current) => ({ ...current, replyTargets: resolveState(value, current.replyTargets) }));
  }

  function setInspectorTab(value: SetStateAction<InspectorTab>) {
    updateActiveWorkspace((current) => ({ ...current, inspectorTab: resolveState(value, current.inspectorTab) }));
  }

  useEffect(() => {
    void checkAuth();
  }, []);

  useEffect(() => {
    if (!authenticated || !authChecked) return;
    const nextQuery = sessionSearch.trim();
    if (nextQuery === loadedSessionQueryRef.current) return;
    const timer = window.setTimeout(() => {
      void refreshSessions(nextQuery);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [authenticated, authChecked, sessionSearch]);

  const hubSocketRef = useRef<ReturnType<typeof connectHubSocket>>(undefined);
  useEffect(() => {
    if (!authenticated) return;
    const disposable = connectHubSocket(socketSessionIds, {
      onState: () => undefined,
      onConnect: () => {
        if (activeSessionIdRef.current) void loadSession(activeSessionIdRef.current);
      },
      onEvent: (event) => {
        setWorkspaceDetail(event.sessionId, (current) =>
          current ? { ...current, events: upsertById(current.events, event).sort(sortEvent) } : current,
        );
        setSessionTabs((current) => markSessionTabUpdated(current, event.sessionId));
        if (event.sessionId !== activeSessionId) return;
        if (event.eventType === "artifact.upsert" || event.eventType === "artifact.complete") setInspectorTab("artifacts");
        if (event.eventType === "file.change") setInspectorTab("diff");
      },
      onSession: (session) => {
        if (session.status !== "active") {
          setSessions((current) => current.filter((item) => item.id !== session.id));
          closeOpenSession(session.id);
          return;
        }
        setSessions((current) => upsertById(current, session).sort(sortSession));
        setWorkspaceDetail(session.id, (current) =>
          current
            ? {
                ...current,
                session,
                runs: session.lastRun
                  ? upsertById(current.runs, { ...session.lastRun, sessionId: session.id }).sort(sortRun)
                  : current.runs,
              }
            : current,
        );
        setSessionTabs((current) => markSessionTabUpdated(current, session.id));
      },
      onMessage: (message) => {
        setWorkspaceDetail(message.sessionId, (current) =>
          current
            ? {
                ...current,
                messages: upsertById(current.messages, message).sort(sortMessage),
                pinnedMessages: message.isPinned
                  ? upsertById(current.pinnedMessages ?? [], message).sort(sortMessage)
                  : (current.pinnedMessages ?? []).filter((item) => item.id !== message.id),
              }
            : current,
        );
        setSessionTabs((current) => markSessionTabUpdated(current, message.sessionId));
      },
      onArtifact: (artifact) => {
        setWorkspaceDetail(artifact.sessionId, (current) =>
          current ? { ...current, artifacts: upsertById(current.artifacts, artifact).sort(sortArtifact) } : current,
        );
        setSessionTabs((current) => markSessionTabUpdated(current, artifact.sessionId));
      },
      onFileChange: (fileChange) => {
        setWorkspaceDetail(fileChange.sessionId, (current) =>
          current ? { ...current, fileChanges: upsertById(current.fileChanges, fileChange).sort(sortFileChange) } : current,
        );
        setSessionTabs((current) => markSessionTabUpdated(current, fileChange.sessionId));
      },
    });
    hubSocketRef.current = disposable;
    return disposable;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  useEffect(() => {
    const preserve = preserveTimelineScrollRef.current;
    const timeline = timelineRef.current;
    if (preserve && timeline) {
      window.requestAnimationFrame(() => {
        timeline.scrollTop = timeline.scrollHeight - preserve.height + preserve.top;
        preserveTimelineScrollRef.current = null;
      });
      return;
    }
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conversationItems.length, detail?.events.length]);

  useEffect(() => {
    if (activeMentionIndex >= mentionCandidates.length) {
      setActiveMentionIndex(0);
    }
  }, [activeMentionIndex, mentionCandidates.length]);

  useEffect(() => {
    if (memberMutationLocked) setContextMenu(null);
  }, [memberMutationLocked]);

  useEffect(() => {
    if (!chatActionLocked) return;
    setMentionMatch(null);
    setActiveMentionIndex(0);
  }, [chatActionLocked]);

  useEffect(() => {
    if (inspectorTab === "files" && !inspectorCollapsed && !sandboxEditorDisabledReason) return;
    setSessionRailCollapsed(false);
    setOpenedFilePath(null);
  }, [inspectorTab, inspectorCollapsed, sandboxEditorDisabledReason]);

  useEffect(() => {
    if (!authenticated || firstRenderMarkedRef.current || !detail) return;
    firstRenderMarkedRef.current = true;
    window.requestAnimationFrame(() => markFrontendPerf("agenthub:first-render:done"));
  }, [authenticated, detail]);

  async function checkAuth() {
    const result = await getAuthState();
    markFrontendPerf("agenthub:auth:done");
    if (result.ok && result.data.authenticated) {
      setCurrentUser(result.data.user ?? null);
      setAuthenticated(true);
      setAuthChecked(true);
      void bootstrap();
      return;
    } else {
      setCurrentUser(null);
      setAuthenticated(false);
      if (result.ok && !result.data.configured) {
        setAuthError("后端未完成用户初始化");
      }
    }
    setAuthChecked(true);
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = authUsername.trim();
    if (!username || !authPassword || authSubmitting) return;
    setAuthSubmitting(true);
    setAuthError("");
    try {
      const result = await loginWithCredentials(username, authPassword);
      if (!result.ok) {
        setAuthError("账号或密码无效");
        return;
      }
      setCurrentUser(result.data.user);
      setAuthenticated(true);
      setAuthPassword("");
      void bootstrap();
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function bootstrap() {
    const requestSeq = ++sessionListRequestSeqRef.current;
    const query = sessionSearch.trim();
    setSessionsLoadingInitial(true);
    const sessionRes = await listSessions({ query, limit: PAGE_SIZE });
    if (requestSeq !== sessionListRequestSeqRef.current) {
      setSessionsLoadingInitial(false);
      return;
    }
    setSessionsLoadingInitial(false);
    loadedSessionQueryRef.current = query;
    markFrontendPerf("agenthub:sessions:list:done");

    if (!sessionRes.ok) {
      setNotice(`后端不可用：${sessionRes.error}`);
      return;
    }

    const items = sessionRes.data.items;
    setSessions(items);
    setSessionsHasMore(sessionRes.data.hasMore);
    setSessionsNextCursor(sessionRes.data.nextCursor ?? null);
    const selected = items[0]?.id ?? null;
    if (selected) {
      void loadSession(selected, { markFirstDetail: true });
    } else {
      setSessionTabs(EMPTY_SESSION_TABS);
      setWorkspaces({});
    }
  }

  async function refreshSessions(query = sessionSearch) {
    const requestSeq = ++sessionListRequestSeqRef.current;
    const normalizedQuery = query.trim();
    const result = await listSessions({ query: normalizedQuery, limit: PAGE_SIZE });
    if (requestSeq !== sessionListRequestSeqRef.current) return;
    if (!result.ok) {
      setNotice(`会话列表加载失败：${result.error}`);
      return;
    }
    loadedSessionQueryRef.current = normalizedQuery;
    setSessions(result.data.items);
    setSessionsHasMore(result.data.hasMore);
    setSessionsNextCursor(result.data.nextCursor ?? null);
  }

  async function ensureAgentsLoaded(options: { force?: boolean } = {}) {
    if (agentsLoadedRef.current && !options.force) return;
    if (agentsRequestRef.current && !options.force) return agentsRequestRef.current;
    const request = (async () => {
      const result = await listAgents();
      if (!result.ok) {
        setNotice(`Agent 列表加载失败：${result.error}`);
        return;
      }
      agentsLoadedRef.current = true;
      setAgents(result.data.items);
    })().finally(() => {
      agentsRequestRef.current = null;
    });
    agentsRequestRef.current = request;
    return request;
  }

  async function ensureTemplatesLoaded(options: { force?: boolean } = {}) {
    if (templatesLoadedRef.current && !options.force) return;
    if (templatesRequestRef.current && !options.force) return templatesRequestRef.current;
    const request = (async () => {
      const result = await listAgentTemplates();
      if (!result.ok) {
        setNotice(`Agent 模板加载失败：${result.error}`);
        return;
      }
      templatesLoadedRef.current = true;
      setTemplates(result.data);
    })().finally(() => {
      templatesRequestRef.current = null;
    });
    templatesRequestRef.current = request;
    return request;
  }

  async function ensureProjectsLoaded(options: { force?: boolean } = {}) {
    if (projectsLoadedRef.current && !options.force) return;
    if (projectsRequestRef.current && !options.force) return projectsRequestRef.current;
    const request = (async () => {
      const result = await listProjects();
      if (!result.ok) {
        setNotice(`项目列表加载失败：${result.error}`);
        return;
      }
      projectsLoadedRef.current = true;
      setProjects(result.data.items);
    })().finally(() => {
      projectsRequestRef.current = null;
    });
    projectsRequestRef.current = request;
    return request;
  }

  async function loadMoreSessions() {
    if (sessionsLoadingMore || !sessionsHasMore || !sessionsNextCursor) return;
    setSessionsLoadingMore(true);
    const requestSeq = sessionListRequestSeqRef.current;
    try {
      const result = await listSessions({ query: sessionSearch, limit: PAGE_SIZE, cursor: sessionsNextCursor });
      if (requestSeq !== sessionListRequestSeqRef.current) return;
      if (!result.ok) {
        setNotice(`更多会话加载失败：${result.error}`);
        return;
      }
      setSessions((current) => mergeById(current, result.data.items).sort(sortSession));
      setSessionsHasMore(result.data.hasMore);
      setSessionsNextCursor(result.data.nextCursor ?? null);
    } finally {
      setSessionsLoadingMore(false);
    }
  }

  function handleSessionListScroll(event: UIEvent<HTMLElement>) {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 80) return;
    void loadMoreSessions();
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = projectNameDraft.trim();
    const githubUrl = projectGithubUrlDraft.trim();
    if (!name || !githubUrl || creatingProject) return;
    setCreatingProject(true);
    try {
      const result = await createProject({ name, githubUrl, defaultBranch: "main" });
      if (!result.ok) {
        setNotice(`项目创建失败：${result.error}`);
        return;
      }
      setProjects((current) => [result.data, ...current.filter((project) => project.id !== result.data.id)]);
      if (activeSessionId) await handleBindProject(result.data.id);
      setProjectDialogOpen(false);
      setProjectNameDraft("");
      setProjectGithubUrlDraft("");
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleBindProject(projectId: string | null) {
    if (!activeSessionId) return;
    const result = await bindSessionProject(activeSessionId, projectId);
    if (!result.ok) {
      setNotice(`项目绑定失败：${result.error}`);
      return;
    }
    setSessions((current) => upsertById(current, result.data).sort(sortSession));
    setDetail((current) => (current?.session.id === result.data.id ? { ...current, session: result.data } : current));
    setDeploymentPreflights((current) => {
      const next = { ...current };
      delete next[activeSessionId];
      return next;
    });
  }

  async function refreshDeploymentPreflight(sessionId: string, options: { silent?: boolean } = {}) {
    const existing = deploymentPreflightRequestRef.current[sessionId];
    if (existing) return existing;
    const request = (async () => {
      const result = await getDeploymentPreflight(sessionId);
      if (!result.ok) {
        if (!options.silent) setNotice(`部署预检失败：${result.error}`);
        return null;
      }
      setDeploymentPreflights((current) => ({ ...current, [sessionId]: result.data }));
      return result.data;
    })().finally(() => {
      delete deploymentPreflightRequestRef.current[sessionId];
    });
    deploymentPreflightRequestRef.current[sessionId] = request;
    return request;
  }

  async function loadSession(sessionId: string, options: { markFirstDetail?: boolean } = {}) {
    setRenamingSession(false);
    setSessionRailCollapsed(false);
    setOpenedFilePath(null);
    preserveTimelineScrollRef.current = null;
    setSessionTabs((current) => activateSessionTab(openSessionTab(current, sessionId), sessionId));
    ensureWorkspace(sessionId);
    if (workspaces[sessionId]?.detail) {
      void ensureAgentsLoaded();
      schedulePinnedMessagesLoad(sessionId);
      closeMentionMenu();
      return;
    }
    const result = await getSessionDetail(sessionId, { messageLimit: PAGE_SIZE });
    if (!result.ok) {
      setNotice(`会话加载失败：${result.error}`);
      return;
    }
    if (options.markFirstDetail || !firstDetailMarkedRef.current) {
      firstDetailMarkedRef.current = true;
      markFrontendPerf("agenthub:first-detail:done");
    }
    updateWorkspace(sessionId, (current) => ({
      ...current,
      detail: result.data,
      timelineHasMore: Boolean(result.data.timelinePage?.hasMore),
      timelineCursor: result.data.timelinePage?.nextCursor ?? null,
      timelineLoadingOlder: false,
    }));
    void ensureAgentsLoaded();
    schedulePinnedMessagesLoad(sessionId);
    closeMentionMenu();
  }

  async function loadOlderTimeline() {
    if (!activeSessionId || !activeWorkspace?.detail || activeWorkspace.timelineLoadingOlder) return;
    if (!activeWorkspace.timelineHasMore || !activeWorkspace.timelineCursor) return;
    const element = timelineRef.current;
    preserveTimelineScrollRef.current = element
      ? { height: element.scrollHeight, top: element.scrollTop }
      : null;
    updateWorkspace(activeSessionId, (current) => ({ ...current, timelineLoadingOlder: true }));
    const result = await listSessionTimeline(activeSessionId, {
      limit: PAGE_SIZE,
      before: activeWorkspace.timelineCursor,
    });
    if (!result.ok) {
      setNotice(`更早消息加载失败：${result.error}`);
      updateWorkspace(activeSessionId, (current) => ({ ...current, timelineLoadingOlder: false }));
      preserveTimelineScrollRef.current = null;
      return;
    }
    updateWorkspace(activeSessionId, (current) => ({
      ...current,
      detail: current.detail ? mergeTimelinePage(current.detail, result.data) : current.detail,
      timelineHasMore: result.data.hasMore,
      timelineCursor: result.data.nextCursor ?? null,
      timelineLoadingOlder: false,
    }));
  }

  function schedulePinnedMessagesLoad(sessionId: string) {
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    };
    if (idleWindow.requestIdleCallback) {
      idleWindow.requestIdleCallback(() => void loadPinnedMessages(sessionId), { timeout: 2000 });
      return;
    }
    window.setTimeout(() => void loadPinnedMessages(sessionId), 300);
  }

  async function loadPinnedMessages(sessionId: string) {
    if (pinnedLoadedRef.current[sessionId]) return;
    const existing = pinnedRequestRef.current[sessionId];
    if (existing) return existing;
    const request = (async () => {
      const result = await listPinnedMessages(sessionId, { limit: 20 });
      if (!result.ok) return;
      pinnedLoadedRef.current[sessionId] = true;
      updateWorkspace(sessionId, (current) => ({
        ...current,
        detail: current.detail ? { ...current.detail, pinnedMessages: result.data.items } : current.detail,
      }));
    })().finally(() => {
      delete pinnedRequestRef.current[sessionId];
    });
    pinnedRequestRef.current[sessionId] = request;
    return request;
  }

  async function ensureSessionOutputsLoaded(sessionId: string) {
    if (outputsLoadedRef.current[sessionId]) return;
    const existing = outputsRequestRef.current[sessionId];
    if (existing) return existing;
    const request = (async () => {
      const [artifactRes, fileChangeRes] = await Promise.all([
        listSessionArtifacts(sessionId),
        listSessionFileChanges(sessionId),
      ]);
      if (!artifactRes.ok) {
        setNotice(`会话产物加载失败：${artifactRes.error}`);
        return;
      }
      if (!fileChangeRes.ok) {
        setNotice(`会话产物加载失败：${fileChangeRes.error}`);
        return;
      }
      outputsLoadedRef.current[sessionId] = true;
      updateWorkspace(sessionId, (current) => ({
        ...current,
        detail: current.detail
          ? {
              ...current.detail,
              artifacts: mergeById(current.detail.artifacts, artifactRes.data.items).sort(sortArtifact),
              fileChanges: mergeById(current.detail.fileChanges, fileChangeRes.data.items).sort(sortFileChange),
            }
          : current.detail,
      }));
    })().finally(() => {
      delete outputsRequestRef.current[sessionId];
    });
    outputsRequestRef.current[sessionId] = request;
    return request;
  }

  function handleTimelineScroll(event: UIEvent<HTMLDivElement>) {
    if (event.currentTarget.scrollTop > 80) return;
    void loadOlderTimeline();
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
    setArchiveConfirmSession(session);
  }

  function closeArchiveConfirmDialog() {
    if (archiveConfirmSession && sessionActionId === archiveConfirmSession.id) return;
    setArchiveConfirmSession(null);
  }

  async function confirmArchiveSession() {
    const session = archiveConfirmSession;
    if (!session || sessionActionId) return;
    setSessionActionId(session.id);
    try {
      const result = await archiveSession(session.id);
      if (!result.ok) {
        setNotice(`归档失败：${result.error}`);
        return;
      }
      setArchiveConfirmSession(null);
      const nextSessions = sessions.filter((item) => item.id !== session.id).sort(sortSession);
      setSessions(nextSessions);
      if (activeSessionId === session.id) {
        const next = nextSessions[0] ?? null;
        closeOpenSession(session.id);
        if (next) await loadSession(next.id);
      }
    } finally {
      setSessionActionId(null);
    }
  }

  function openCreateGroupDialog() {
    void ensureTemplatesLoaded();
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
      setNotice("请选择用于创建单聊实例的 Agent 模板");
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
    setSessionTabs((current) => activateSessionTab(openSessionTab(current, result.data.id), result.data.id));
    updateWorkspace(result.data.id, (current) => ({ ...current, detail: { session: result.data, ...EMPTY_DETAIL } }));
    await ensureAgentsLoaded({ force: true });
    closeMentionMenu();
    closeGroupDialog();
  }

  async function handleSend() {
    const text = composer.trim();
    if (!text || !activeSessionId || runActionLocked || sending) return;
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
        parentMessageId: replyTargets[0]?.message.id,
        quotedMessageId: replyTargets[0]?.message.id,
        references: replyTargets.map((target) => ({ messageId: target.message.id, partId: target.partId })),
        attachments: attachments.map((item) => ({ id: item.id })),
      });
      if (!result.ok) {
        setNotice(`发送失败：${result.error}`);
        return;
      }
      setDetail((current) => {
        const base = current ?? { session: result.data.session, ...EMPTY_DETAIL };
        const responseMessages = result.data.messages?.length ? result.data.messages : [result.data.message];
        let messages = base.messages;
        for (const message of responseMessages) {
          messages = upsertById(messages, message);
        }
        return {
          ...base,
          session: result.data.session,
          messages: messages.sort(sortMessage),
          runs: upsertById(base.runs, result.data.run).sort(sortRun),
        };
      });
      setSessions((current) => upsertById(current, result.data.session).sort(sortSession));
      setAttachments([]);
      setReplyTargets([]);
      setNotice(mode === "direct" ? "消息已发送给 Agent" : "消息已发送给 Orchestrator");
    } finally {
      setSending(false);
    }
  }

  function updateMessageInDetail(message: HubMessageDto) {
    setDetail((current) =>
      current
        ? {
            ...current,
            messages: upsertById(current.messages, message).sort(sortMessage),
            pinnedMessages: message.isPinned
              ? upsertById(current.pinnedMessages ?? [], message).sort(sortMessage)
              : (current.pinnedMessages ?? []).filter((item) => item.id !== message.id),
          }
        : current,
    );
  }

  async function handlePin(message: HubMessageDto) {
    if (!activeSessionId) return;
    const result = await pinSessionMessage(activeSessionId, message.id, { pinned: !message.isPinned });
    if (!result.ok) {
      setNotice(`Pin 失败：${result.error}`);
      return;
    }
    updateMessageInDetail(result.data);
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

  function handleEditAgent(body: UpdateAgentRequest) {
    if (!editTarget || memberMutationLocked) return;
    const previousAgent = editTarget;
    const optimisticAgent: AgentInstanceDto = {
      ...previousAgent,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
    };
    const updateSeq = (agentUpdateSeqRef.current[previousAgent.id] ?? 0) + 1;
    agentUpdateSeqRef.current[previousAgent.id] = updateSeq;
    setAgents((current) => upsertById(current, optimisticAgent));
    setEditDialogOpen(false);
    setEditTarget(null);
    setNotice(`Agent "${optimisticAgent.name}" 已更新`);
    void updateAgent(previousAgent.id, body)
      .then((result) => {
        if (agentUpdateSeqRef.current[previousAgent.id] !== updateSeq) return;
        if (!result.ok) {
          setAgents((current) => upsertById(current, previousAgent));
          setNotice(`Agent 保存失败：${result.error}`);
          return;
        }
        setAgents((current) => upsertById(current, result.data));
      })
      .catch((error: unknown) => {
        if (agentUpdateSeqRef.current[previousAgent.id] !== updateSeq) return;
        setAgents((current) => upsertById(current, previousAgent));
        setNotice(`Agent 保存失败：${error instanceof Error ? error.message : "网络异常"}`);
      });
  }

  function openProfileDialog() {
    setProfileDraft({
      displayName: currentUserName,
      avatarUrl: currentUser?.avatarUrl ?? null,
    });
    setProfileError("");
    setProfileDialogOpen(true);
  }

  function handleSaveProfile() {
    const displayName = profileDraft.displayName.trim();
    if (!displayName || !currentUser) return;
    const previousUser = currentUser;
    const optimisticUser: AuthUserDto = {
      ...previousUser,
      displayName,
      avatarUrl: profileDraft.avatarUrl,
    };
    const updateSeq = profileUpdateSeqRef.current + 1;
    profileUpdateSeqRef.current = updateSeq;
    setProfileError("");
    setCurrentUser(optimisticUser);
    setProfileDialogOpen(false);
    setNotice("个人信息已更新");
    void updateCurrentUser({
      displayName,
      avatarUrl: profileDraft.avatarUrl,
    })
      .then((result) => {
        if (profileUpdateSeqRef.current !== updateSeq) return;
        if (!result.ok) {
          setCurrentUser(previousUser);
          setNotice(`个人信息保存失败：${result.error}`);
          return;
        }
        setCurrentUser(result.data);
      })
      .catch((error: unknown) => {
        if (profileUpdateSeqRef.current !== updateSeq) return;
        setCurrentUser(previousUser);
        setNotice(`个人信息保存失败：${error instanceof Error ? error.message : "网络异常"}`);
      });
  }

  function handleProfileAvatarFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    void readAvatarFile(file).then((base64) => {
      if (!base64) return;
      void uploadAvatar(base64, file.type).then((result) => {
        if (!result.ok) { setProfileError(`头像上传失败：${result.error}`); return; }
        setProfileError("");
        setProfileDraft((current) => ({ ...current, avatarUrl: result.data.avatarUrl }));
      });
    });
  }

  function handleAgentAvatarFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file || !editTarget) return;
    void readAvatarFile(file).then((base64) => {
      if (!base64) return;
      void uploadAvatar(base64, file.type).then((result) => {
        if (!result.ok) { setNotice(`头像上传失败：${result.error}`); return; }
        setNotice("");
        setEditTarget((current) => (current ? { ...current, avatarUrl: result.data.avatarUrl } : current));
      });
    });
  }

  async function handleDeleteAgent() {
    if (!deleteTarget || memberMutationLocked) return;
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
    setNotice(`Agent "${deleteTarget.name}" 已删除`);
  }

  function openAgentTemplateDialog() {
    window.location.href = "/agent-templates/build";
  }

  async function handleInviteAgent() {
    if (!activeSessionId || memberMutationLocked) return;
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
    setNotice(errorCount > 0 ? "部分成员加入失败" : "成员已加入");
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

  async function handleRegenerate(message: HubMessageDto) {
    if (!activeSessionId || runActionLocked || sending) return;
    setSending(true);
    try {
      const result = await regenerateSessionMessage(activeSessionId, message.id);
      if (!result.ok) {
        setNotice(`重新生成失败：${result.error}`);
        return;
      }
      setDetail((current) => {
        const base = current ?? { session: result.data.session, ...EMPTY_DETAIL };
        const responseMessages = result.data.messages?.length ? result.data.messages : [result.data.message];
        let messages = base.messages;
        for (const message of responseMessages) {
          messages = upsertById(messages, message);
        }
        return {
          ...base,
          session: result.data.session,
          messages: messages.sort(sortMessage),
          runs: upsertById(base.runs, result.data.run).sort(sortRun),
        };
      });
      setSessions((current) => upsertById(current, result.data.session).sort(sortSession));
      setNotice("已创建新的重新生成 run");
    } finally {
      setSending(false);
    }
  }

  async function handleStartDeployment() {
    if (!activeSessionId || runActionLocked || deployingSessionId) return;
    const preflight = deploymentPreflight ?? await refreshDeploymentPreflight(activeSessionId);
    if (!canDeploy(preflight)) {
      setNotice(deploymentPreflightText(preflight));
      return;
    }
    setDeployingSessionId(activeSessionId);
    try {
      const result = await startDeployment(activeSessionId);
      if (!result.ok) {
        setNotice(`Vercel 部署失败：${result.error}`);
        return;
      }
      setDetail((current) =>
        current ? { ...current, messages: upsertById(current.messages, result.data.message).sort(sortMessage) } : current,
      );
      await refreshDeploymentPreflight(activeSessionId);
      setNotice(`Vercel 部署已触发：${result.data.deployment.commitSha.slice(0, 12)}`);
    } finally {
      setDeployingSessionId(null);
    }
  }

  function handleArtifactSelection(artifact: HubArtifactDto, selectedText: string) {
    if (!sessionWritable) {
      setNotice("归档会话为只读，不能发起局部修改");
      return;
    }
    const prompt = [
      `请修改产物「${artifact.title}」中的选中内容：`,
      "",
      "```",
      selectedText,
      "```",
      "",
      "修改要求：",
    ].join("\n");
    setComposer((current) => (current.trim() ? `${current.trim()}\n\n${prompt}` : prompt));
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function handleArtifactDraft(artifact: HubArtifactDto, editedText: string) {
    if (!sessionWritable) {
      setNotice("归档会话为只读，不能继续修改产物");
      return;
    }
    const original = artifact.textContent?.trim();
    const prompt = [
      `我编辑了产物「${artifact.title}」v${artifact.version} 的草稿，请基于编辑后的内容继续处理：`,
      "",
      original ? "原始内容摘要：" : "",
      original ? "```" : "",
      original ? clipForPrompt(original, 2000) : "",
      original ? "```" : "",
      "",
      "编辑后内容：",
      "```",
      clipForPrompt(editedText, 12000),
      "```",
      "",
      "请根据这份编辑后内容继续修改或生成后续产物。",
    ].filter((line) => line !== "").join("\n");
    setComposer((current) => (current.trim() ? `${current.trim()}\n\n${prompt}` : prompt));
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function openArtifactViewer(artifactId: string) {
    if (!detail?.artifacts.some((artifact) => artifact.id === artifactId)) {
      if (!activeSessionId) {
        setNotice("产物还没有同步到本地列表，请稍后再展开");
        return;
      }
      await ensureSessionOutputsLoaded(activeSessionId);
    }
    focusArtifactsPanel();
    setActiveArtifactViewerId(artifactId);
  }

  function focusDiffPanel() {
    setInspectorCollapsed(false);
    setInspectorTab("diff");
    setSessionRailCollapsed(false);
    setOpenedFilePath(null);
  }

  function focusArtifactsPanel() {
    setInspectorCollapsed(false);
    setInspectorTab("artifacts");
    setSessionRailCollapsed(false);
    setOpenedFilePath(null);
    if (activeSessionId) void ensureSessionOutputsLoaded(activeSessionId);
  }

  function selectInspectorTab(tab: InspectorTab) {
    setInspectorTab(tab);
    if (tab === "artifacts" && activeSessionId) void ensureSessionOutputsLoaded(activeSessionId);
    if (tab !== "files") {
      setSessionRailCollapsed(false);
      setOpenedFilePath(null);
    }
  }

  function toggleInspectorCollapsed() {
    setInspectorCollapsed((current) => {
      const next = !current;
      if (next) setSessionRailCollapsed(false);
      return next;
    });
  }

  function handleFileOpened(path: string) {
    setOpenedFilePath(path);
    setSessionRailCollapsed(true);
  }

  function addReplyTarget(message: HubMessageDto) {
    if (!sessionWritable) return;
    setReplyTargets((current) => {
      if (current.some((item) => item.message.id === message.id && !item.partId)) return current;
      return [...current, { message, preview: message.contentText.slice(0, 48) || message.role }].slice(0, 5);
    });
  }

  function addReplyPartTarget(message: HubMessageDto, part: HubMessagePartDto) {
    if (!sessionWritable) return;
    setReplyTargets((current) => {
      if (current.some((item) => item.message.id === message.id && item.partId === part.id)) return current;
      const preview = part.title ?? part.text?.slice(0, 48) ?? part.type;
      return [...current, { message, partId: part.id, preview }].slice(0, 5);
    });
  }

  async function uploadAttachmentFiles(files: File[]) {
    if (!activeSessionId || runActionLocked || files.length === 0 || uploadingAttachment) return;
    const selected = files.slice(0, Math.max(0, 5 - attachments.length));
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
    }
  }

  async function handleAttachmentFiles(files: FileList | null) {
    await uploadAttachmentFiles(files ? Array.from(files) : []);
    if (fileInputRef.current) fileInputRef.current.value = "";
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

  async function handlePinPart(message: HubMessageDto, part: HubMessagePartDto) {
    if (!activeSessionId) return;
    const result = await pinSessionMessage(activeSessionId, message.id, { pinned: !part.pinned, partId: part.id });
    if (!result.ok) {
      setNotice(`Part Pin 失败：${result.error}`);
      return;
    }
    updateMessageInDetail(result.data);
  }

  async function handleUnpinKeyMessage(message: HubMessageDto) {
    if (!activeSessionId) return;
    const pinnedParts = message.parts.filter((part) => part.pinned);

    if (message.isPinned) {
      const result = await pinSessionMessage(activeSessionId, message.id, { pinned: false });
      if (!result.ok) {
        setNotice(`取消关键消息失败：${result.error}`);
        return;
      }
      updateMessageInDetail(result.data);
    }

    for (const part of pinnedParts) {
      const result = await pinSessionMessage(activeSessionId, message.id, { pinned: false, partId: part.id });
      if (!result.ok) {
        setNotice(`取消关键片段失败：${result.error}`);
        return;
      }
      updateMessageInDetail(result.data);
    }
  }

  if (!authenticated) {
    return (
      <main className="authShell">
        <form className="authPanel" onSubmit={(event) => void handleLogin(event)}>
          <div>
            <strong>AgentHub</strong>
            <span>使用管理员账号登录</span>
          </div>
          <input
            aria-label="账号"
            autoFocus
            type="text"
            value={authUsername}
            onChange={(event) => setAuthUsername(event.target.value)}
            placeholder="账号"
          />
          <input
            aria-label="密码"
            type="password"
            value={authPassword}
            onChange={(event) => setAuthPassword(event.target.value)}
            placeholder="密码"
          />
          {authError && <small className="authError">{authError}</small>}
          <button className="primaryButton" type="submit" disabled={!authUsername.trim() || !authPassword || authSubmitting}>
            {authSubmitting ? <LoadingOutlined /> : null}
            <span>进入</span>
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className={shellClassName}>
      <aside className="sessionRail">
        <div className="imRailTop">
          <button className="railNavButton primary" type="button" onClick={openCreateGroupDialog}>
            <PlusOutlined />
            <span>新对话</span>
          </button>
          <label className="sessionSearch">
            <SearchOutlined />
            <input
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
              placeholder="搜索"
            />
          </label>
          <button className="railNavButton" type="button" onClick={openAgentTemplateDialog}>
            <RobotOutlined />
            <span>Agent 模板</span>
          </button>
          <button className="railProfileButton" type="button" onClick={openProfileDialog}>
            <AvatarFace
              className="railProfileAvatar"
              name={currentUserName}
              avatarUrl={currentUser?.avatarUrl}
              colorKey={currentUser?.userId ?? currentUserName}
            />
            <span>编辑个人信息</span>
          </button>
        </div>

        <div className="statusStack">
        <section className="groupSummary">
            <button
              className="groupSummaryHeader"
              type="button"
              aria-expanded={groupMembersExpanded}
              onClick={() => setGroupMembersExpanded((v) => !v)}
            >
              <strong>{mode === "direct" ? "单聊 Agent" : "群聊成员"}</strong>
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
                      if (memberMutationLocked || mode !== "group") return;
                      e.preventDefault();
                      setContextMenu({ agentId: agent.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <AvatarFace name={agent.name} avatarUrl={agent.avatarUrl} colorKey={agent.id} />
                    <span className="memberMeta">
                      <span>
                        <span className="memberName">{agent.name}</span>
                        {mode === "group" && agent.id === orchestrator?.id && <span className="memberOrchTag">协调者</span>}
                      </span>
                      <CapabilityTags capabilities={agent.capabilities} />
                    </span>
                  </div>
                ))}
                {mode === "group" && sessionWritable && (
                  <button
                    className="addMemberRow"
                    type="button"
                    disabled={memberMutationLocked}
                    title={activeRunInProgress ? "运行中不能修改成员" : "添加成员"}
                    onClick={() => {
                      if (memberMutationLocked) return;
                      void ensureTemplatesLoaded();
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

        <nav className="sessionList" aria-label="会话" onScroll={handleSessionListScroll}>
          {sessionsLoadingInitial && sessions.length === 0 && <p className="emptySessionList">加载最近会话...</p>}
          {!sessionsLoadingInitial && sessions.length === 0 && <p className="emptySessionList">没有匹配的会话</p>}
          {sessions.map((session) => {
            const sessionBusy = isRunning(session.lastRun?.status ?? "");
            const actionBusy = sessionActionId === session.id;
            return (
              <div
                key={session.id}
                className={`sessionItem ${session.id === activeSessionId ? "active" : ""}`}
              >
                <span className="sessionAvatar" style={{ background: agentColor(session.id) }}>
                  {initials(session.title)}
                </span>
                <button className="sessionItemMain" type="button" onClick={() => void loadSession(session.id)}>
                  <span className="sessionItemTop">
                    <span className="sessionTitle">
                      {session.isPinned && <PushpinFilled />}
                      <span>{session.title}</span>
                    </span>
                    <time>{formatTime(session.updatedAt)}</time>
                  </span>
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
                </div>
              </div>
            );
          })}
          {sessionsLoadingMore && <p className="emptySessionList">加载更多会话...</p>}
        </nav>
      </aside>
      {shouldCollapseSessionRail && inspectorCollapsed && (
        <button className="railRestoreButton" type="button" title="展开左侧会话栏" onClick={() => setSessionRailCollapsed(false)}>
          <MenuUnfoldOutlined />
          <span>会话</span>
        </button>
      )}

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
              <button
                className="iconButton"
                type="button"
                title={sessionWritable ? "重命名会话" : "归档会话只读"}
                disabled={!sessionWritable}
                onClick={beginRenameSession}
              >
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

        <PinnedKeyMessages
          messages={pinnedMessages}
          onReply={!chatActionLocked ? addReplyTarget : undefined}
          onUnpin={handleUnpinKeyMessage}
          onOpenPart={setActivePartViewer}
        />

        <div className="timeline" ref={timelineRef} onScroll={handleTimelineScroll}>
          {activeWorkspace?.timelineLoadingOlder && <p className="emptySessionList">加载更早消息...</p>}
          {conversationItems.map((item) =>
            item.kind === "message" ? (
              <TimelineMessage
                key={item.id}
                message={item.message}
                onPin={handlePin}
                onPinPart={handlePinPart}
                onReply={!chatActionLocked ? addReplyTarget : undefined}
                onReferencePart={!chatActionLocked ? addReplyPartTarget : undefined}
                onRegenerate={!chatActionLocked ? (message) => void handleRegenerate(message) : undefined}
                onOpenArtifact={openArtifactViewer}
                onOpenPart={setActivePartViewer}
                onOpenDiffPanel={focusDiffPanel}
                onOpenArtifactsPanel={focusArtifactsPanel}
                agents={agents}
                currentUser={currentUser}
              />
            ) : (
              <RunThread
                key={item.id}
                run={item.run}
                events={item.events}
                fileChanges={item.fileChanges}
                artifacts={item.artifacts}
                messages={item.messages}
                agents={agents}
                currentUser={currentUser}
                onPinPart={handlePinPart}
                onReply={!chatActionLocked ? addReplyTarget : undefined}
                onReferencePart={!chatActionLocked ? addReplyPartTarget : undefined}
                onRegenerate={!chatActionLocked ? (message) => void handleRegenerate(message) : undefined}
                onOpenArtifact={openArtifactViewer}
                onOpenPart={setActivePartViewer}
                onOpenDiffPanel={focusDiffPanel}
                onOpenArtifactsPanel={focusArtifactsPanel}
              />
            ),
          )}
          <div ref={endRef} />
        </div>

        <footer className="composer">
          {replyTargets.length > 0 && (
            <div className="replyBanner">
              <span>
                引用 {replyTargets.length}/5：
                {replyTargets.map((target) => `${target.partId ? "片段 " : ""}${target.preview.slice(0, 28)}`).join(" / ")}
              </span>
              <button type="button" onClick={() => setReplyTargets([])}>
                取消
              </button>
            </div>
          )}
          <div className="composerInputWrap">
            {attachments.length > 0 && (
              <div className="attachmentTray" aria-label="待发送附件">
                {attachments.map((attachment) => (
                  <ComposerAttachmentCard
                    attachment={attachment}
                    key={attachment.id}
                    onRemove={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  />
                ))}
              </div>
            )}
            {mentionMatch && !sending && activeSessionId && !chatActionLocked && (
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
                      <AvatarFace name={agent.name} avatarUrl={agent.avatarUrl} colorKey={agent.id} />
                      <span>
                        <strong>@{agent.name}</strong>
                        <small>{agent.template?.name ?? "worker"}</small>
                        <CapabilityTags capabilities={agent.capabilities} />
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
              placeholder="发消息..."
              onPaste={(event) => {
                const files = clipboardAttachmentFiles(event.clipboardData);
                if (!files.length || !activeSessionId || chatActionLocked) return;
                event.preventDefault();
                void uploadAttachmentFiles(files);
              }}
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
              disabled={sending || !activeSessionId || !sessionWritable || (mode === "direct" && !directAgent)}
            />
          </div>
          <div className="composerBar">
            <span>
              {sessionReadOnly
                ? "归档会话只读"
                : !activeSession
                  ? "请选择会话"
                : mode === "direct"
                ? directAgent
                  ? `单聊：${directAgent.name}`
                  : "请选择单聊 Agent"
                : parsedMentionIds.length
                ? "将发送给已 @ 成员"
                : ""}
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
              disabled={!activeSessionId || chatActionLocked || uploadingAttachment || attachments.length >= 5}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingAttachment ? <LoadingOutlined /> : <PaperClipOutlined />}
            </button>
            <button
              className="primaryButton"
              type="button"
              disabled={!composer.trim() || sending || !activeSessionId || chatActionLocked || (mode === "direct" && !directAgent)}
              onClick={() => void handleSend()}
            >
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
            onClick={toggleInspectorCollapsed}
          >
            {inspectorCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            <span>{inspectorCollapsed ? "展开" : "收起"}</span>
          </button>
          <button
            className={inspectorTab === "files" ? "active" : ""}
            type="button"
            onClick={() => selectInspectorTab("files")}
          >
            <FileOutlined />
            <span>文件</span>
          </button>
          <button className={inspectorTab === "diff" ? "active" : ""} type="button" onClick={() => selectInspectorTab("diff")}>
            <BranchesOutlined />
            <span>审查</span>
          </button>
          <button
            className={inspectorTab === "artifacts" ? "active" : ""}
            type="button"
            onClick={() => selectInspectorTab("artifacts")}
          >
            <FileDoneOutlined />
            <span>Artifacts</span>
          </button>
        </div>

        {!inspectorCollapsed && (
          <>
            {inspectorTab === "files" && (
              <FilePanel
                sessionId={activeSessionId}
                disabledReason={sandboxEditorDisabledReason}
                onSaved={() => {
                  setInspectorTab("diff");
                  setMainGitRefreshSignal((value) => value + 1);
                }}
                onNotice={setNotice}
                onFileOpened={handleFileOpened}
              />
            )}
            {inspectorTab === "diff" && (
              <MainGitDiffPanel sessionId={activeSessionId ?? ""} refreshSignal={mainGitRefreshSignal} onNotice={setNotice} />
            )}
            {inspectorTab === "artifacts" && (
              <ArtifactPanel
                artifacts={detail?.artifacts ?? []}
                onUseSelection={handleArtifactSelection}
                onUseDraft={handleArtifactDraft}
              />
            )}
          </>
        )}
      </aside>

      {activeArtifactViewer && (
        <ArtifactViewerLayer
          artifact={activeArtifactViewer}
          onClose={() => setActiveArtifactViewerId(null)}
          onUseSelection={handleArtifactSelection}
          onUseDraft={handleArtifactDraft}
        />
      )}

      {activePartViewer && (
        <MessagePartViewerLayer
          part={activePartViewer}
          onClose={() => setActivePartViewer(null)}
        />
      )}

      {projectDialogOpen && (
        <div className="dialogLayer" role="presentation" onMouseDown={closeProjectDialog}>
          <section
            className="groupDialog projectDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-project-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong id="create-project-title">新建项目</strong>
              </div>
            </header>
            <form className="projectForm" onSubmit={(event) => void handleCreateProject(event)}>
              <div className="buildForm">
                <label>
                  项目名称
                  <input
                    value={projectNameDraft}
                    onChange={(event) => setProjectNameDraft(event.target.value)}
                    placeholder="AgentHub Course Demo"
                    autoFocus
                    required
                  />
                </label>
                <label>
                  GitHub 绑定地址
                  <input
                    value={projectGithubUrlDraft}
                    onChange={(event) => setProjectGithubUrlDraft(event.target.value)}
                    placeholder="https://github.com/org/repo"
                    inputMode="url"
                    required
                  />
                </label>
                <p className="dialogHint">创建单聊或群聊会话，选择 Agent 开始对话。</p>
              </div>
              <footer>
                <button className="ghostButton" type="button" disabled={creatingProject} onClick={closeProjectDialog}>
                  取消
                </button>
                <button
                  className="primaryButton"
                  type="submit"
                  disabled={!projectNameDraft.trim() || !projectGithubUrlDraft.trim() || creatingProject}
                >
                  {creatingProject ? <LoadingOutlined /> : <PlusOutlined />}
                  <span>创建并绑定</span>
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

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
                    实例名称
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
                      <AvatarFace name={tpl.name} colorKey={tpl.id} />
                      <span>
                        <strong>{tpl.name}</strong>
                        <small>{tpl.description.slice(0, 40)}</small>
                        <CapabilityTags capabilities={tpl.defaultCapabilities} />
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

      {contextMenu && !memberMutationLocked && (
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
            {contextMenu.agentId !== orchestrator?.id && (
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
                <DeleteOutlined /> 从群聊中删除
              </button>
            )}
          </div>
        </div>
      )}

      {profileDialogOpen && (
        <div className="dialogLayer" role="presentation" onMouseDown={() => setProfileDialogOpen(false)}>
          <section
            className="agentDialog profileDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-profile-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <strong id="edit-profile-title">编辑个人信息</strong>
              </div>
            </header>
            <div className="buildForm">
              <div className="avatarEditor">
                <AvatarFace
                  className="avatarPreview"
                  name={profileDraft.displayName || currentUserName}
                  avatarUrl={profileDraft.avatarUrl}
                  colorKey={currentUser?.userId ?? currentUserName}
                />
                <div className="avatarEditorActions">
                  <input
                    ref={profileAvatarInputRef}
                    className="hiddenFileInput"
                    type="file"
                    accept={AVATAR_ACCEPT}
                    onChange={(event) => handleProfileAvatarFiles(event.target.files)}
                  />
                  <button className="ghostButton" type="button" onClick={() => profileAvatarInputRef.current?.click()}>
                    <UploadOutlined />
                    <span>选择头像</span>
                  </button>
                  {profileDraft.avatarUrl && (
                    <button
                      className="ghostButton"
                      type="button"
                      onClick={() => setProfileDraft((current) => ({ ...current, avatarUrl: null }))}
                    >
                      移除头像
                    </button>
                  )}
                </div>
              </div>
              <label>名称
                <input
                  value={profileDraft.displayName}
                  onChange={(event) => setProfileDraft((current) => ({ ...current, displayName: event.target.value }))}
                  autoFocus
                />
              </label>
              {profileError && <p className="dialogHint error">{profileError}</p>}
            </div>
            <footer>
              <button className="ghostButton" type="button" onClick={() => setProfileDialogOpen(false)}>
                取消
              </button>
              <button
                className="primaryButton"
                type="button"
                disabled={!profileDraft.displayName.trim()}
                onClick={handleSaveProfile}
              >
                <span>保存</span>
              </button>
            </footer>
          </section>
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
              </div>
            </header>
            <div className="buildForm">
              <div className="avatarEditor">
                <AvatarFace
                  className="avatarPreview"
                  name={editTarget.name}
                  avatarUrl={editTarget.avatarUrl}
                  colorKey={editTarget.id}
                />
                <div className="avatarEditorActions">
                  <input
                    ref={agentAvatarInputRef}
                    className="hiddenFileInput"
                    type="file"
                    accept={AVATAR_ACCEPT}
                    onChange={(event) => handleAgentAvatarFiles(event.target.files)}
                  />
                  <button className="ghostButton" type="button" onClick={() => agentAvatarInputRef.current?.click()}>
                    <UploadOutlined />
                    <span>选择头像</span>
                  </button>
                  {editTarget.avatarUrl && (
                    <button
                      className="ghostButton"
                      type="button"
                      onClick={() => setEditTarget({ ...editTarget, avatarUrl: null })}
                    >
                      移除头像
                    </button>
                  )}
                </div>
              </div>
              <label>名称
                <input
                  value={editTarget.name}
                  onChange={(e) => setEditTarget({ ...editTarget, name: e.target.value })}
                />
              </label>
            </div>
            <footer>
              <button className="ghostButton" type="button" onClick={() => { setEditDialogOpen(false); setEditTarget(null); }}>
                取消
              </button>
              <button
                className="primaryButton"
                type="button"
                disabled={memberMutationLocked || !editTarget.name.trim()}
                title={activeRunInProgress ? "运行中不能修改成员" : "保存"}
                onClick={() => handleEditAgent({
                  name: editTarget.name.trim(),
                  avatarUrl: editTarget.avatarUrl ?? null,
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
                      <AvatarFace name={tpl.name} colorKey={tpl.id} />
                      <span>
                        <strong>{tpl.name}</strong>
                        <small>{tpl.description.slice(0, 40)}</small>
                        <CapabilityTags capabilities={tpl.defaultCapabilities} />
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
              <button
                className="primaryButton"
                type="button"
                disabled={memberMutationLocked}
                title={activeRunInProgress ? "运行中不能修改成员" : "邀请加入"}
                onClick={() => void handleInviteAgent()}
              >
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
                <strong id="delete-agent-title">确认删除</strong>
              </div>
            </header>
            <p className="deleteConfirmText">
              确定要从群聊中删除 <strong>{deleteTarget.name}</strong> 吗？此操作不可撤销。
            </p>
            <footer>
              <button className="ghostButton" type="button" onClick={() => { setDeleteConfirmOpen(false); setDeleteTarget(null); }}>
                取消
              </button>
              <button
                className="dangerButton"
                type="button"
                disabled={memberMutationLocked}
                title={activeRunInProgress ? "运行中不能修改成员" : "确认删除"}
                onClick={() => void handleDeleteAgent()}
              >
                确认删除
              </button>
            </footer>
          </section>
        </div>
      )}

      {archiveConfirmSession && (
        <div className="dialogLayer" role="presentation" onMouseDown={closeArchiveConfirmDialog}>
          <section
            className="agentDialog archiveDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-session-title"
            aria-describedby="archive-session-desc"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="archiveDialogHeader">
              <span className="archiveDialogIcon" aria-hidden="true">
                <InboxOutlined />
              </span>
              <div>
                <strong id="archive-session-title">归档会话</strong>
              </div>
              <button
                className="iconButton"
                type="button"
                aria-label="关闭归档确认"
                title="关闭"
                disabled={sessionActionId === archiveConfirmSession.id}
                onClick={closeArchiveConfirmDialog}
              >
                <CloseOutlined />
              </button>
            </header>
            <div className="archiveDialogBody" id="archive-session-desc">
              <div className="archiveDialogSession">
                <span className="sessionAvatar" style={{ background: agentColor(archiveConfirmSession.id) }}>
                  {initials(archiveConfirmSession.title)}
                </span>
                <div>
                  <strong>{archiveConfirmSession.title}</strong>
                  <small>{sessionSubtitle(archiveConfirmSession)}</small>
                </div>
              </div>
              <ul className="archiveDialogList">
                <li>
                  <CheckCircleOutlined />
                  <span>历史消息、产物和文件记录会保留。</span>
                </li>
                <li>
                  <CheckCircleOutlined />
                  <span>归档后会话为只读，不能继续发送消息或编辑文件。</span>
                </li>
              </ul>
              <p className="archiveDialogNote">需要继续协作时，请选择其他会话或新建对话。</p>
            </div>
            <footer>
              <button
                className="ghostButton"
                type="button"
                disabled={sessionActionId === archiveConfirmSession.id}
                onClick={closeArchiveConfirmDialog}
              >
                取消
              </button>
              <button
                className="primaryButton"
                type="button"
                disabled={sessionActionId === archiveConfirmSession.id}
                onClick={() => void confirmArchiveSession()}
              >
                {sessionActionId === archiveConfirmSession.id ? <LoadingOutlined /> : <InboxOutlined />}
                <span>{sessionActionId === archiveConfirmSession.id ? "归档中" : "归档会话"}</span>
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

function canDeploy(preflight: DeploymentPreflightResponse | null | undefined) {
  return Boolean(preflight?.canDeploy);
}

function deploymentPreflightText(preflight: DeploymentPreflightResponse | null | undefined) {
  if (!preflight) return "正在检查 Vercel 部署条件";
  if (preflight.canDeploy) {
    const commit = preflight.latestSuccessfulPushCommitSha?.slice(0, 12);
    return commit ? `将部署到 Vercel Production：${commit}` : "可部署到 Vercel";
  }
  if (!preflight.projectBound) return "先绑定项目";
  if (!preflight.latestSuccessfulPushCommitSha) return "等待下游上报 push commit";
  if (!preflight.vercelConfigured) return "后端未配置 VERCEL_TOKEN";
  return "仅支持公开 GitHub 仓库";
}

function markFrontendPerf(label: string) {
  if (process.env.NODE_ENV === "production" || typeof performance === "undefined") return;
  performance.mark(label);
  console.info(`[perf] ${label} ${Math.round(performance.now())}ms`);
}

function clipForPrompt(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...（已截断 ${text.length - limit} 字符）`;
}

function resolveState<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === "function" ? (value as (previous: T) => T)(current) : value;
}

function sessionListPreview(session: HubSessionDto) {
  const timeSuffix = ` · ${formatTime(session.updatedAt)}`;
  const subtitle = sessionSubtitle(session);
  return subtitle.endsWith(timeSuffix) ? subtitle.slice(0, -timeSuffix.length) : subtitle;
}

function PinnedKeyMessages({
  messages,
  onReply,
  onUnpin,
  onOpenPart,
}: {
  messages: HubMessageDto[];
  onReply?: (message: HubMessageDto) => void;
  onUnpin?: (message: HubMessageDto) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
}) {
  const visibleMessages = messages.slice(0, 5);
  if (visibleMessages.length === 0) return null;

  return (
    <section className="pinnedKeyMessages" aria-label="关键消息">
      <div className="pinnedKeyHeader">
        <span>
          <PushpinFilled />
          <strong>关键消息</strong>
        </span>
        <small>{messages.length}</small>
      </div>
      <div className="pinnedKeyList">
        {visibleMessages.map((message) => {
          const pinnedParts = message.parts.filter((part) => part.pinned);
          return (
            <article className="pinnedKeyItem" key={message.id}>
              <div className="pinnedKeyMeta">
                <span>{messageSpeaker(message)} · {formatTime(message.updatedAt)}</span>
                <div className="pinnedKeyActions">
                  {onReply && (
                    <button type="button" onClick={() => onReply(message)}>
                      引用
                    </button>
                  )}
                  {onUnpin && (
                    <button
                      className="pinnedKeyCancel"
                      type="button"
                      title="取消关键消息"
                      onClick={() => onUnpin(message)}
                    >
                      取消
                    </button>
                  )}
                </div>
              </div>
              {message.isPinned && <p>{messagePreview(message)}</p>}
              {pinnedParts.length > 0 && (
                <div className="pinnedPartList">
                  {pinnedParts.map((part) =>
                    onOpenPart ? (
                      <button
                        className="pinnedPartChip"
                        key={part.id}
                        type="button"
                        title="展开 Pin 片段"
                        onClick={() => onOpenPart(part)}
                      >
                        <span>{partTypeLabel(part)}</span>
                        <strong>{partPreview(part)}</strong>
                      </button>
                    ) : (
                      <span className="pinnedPartChip" key={part.id}>
                        <span>{partTypeLabel(part)}</span>
                        <strong>{partPreview(part)}</strong>
                      </span>
                    ),
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function hasPinnedMessageContent(message: HubMessageDto) {
  return message.isPinned || message.parts.some((part) => part.pinned);
}

function messageSpeaker(message: HubMessageDto) {
  if (message.role === "user") return "你";
  return message.agentName ?? "Agent";
}

function messagePreview(message: HubMessageDto) {
  const text = message.contentText.trim();
  if (text) return clipInline(text, 112);
  const part = message.parts.find((item) => item.text || item.title || item.url) ?? message.parts[0];
  return part ? partPreview(part) : "空消息";
}

function partPreview(part: HubMessagePartDto) {
  if (part.title) return clipInline(part.title, 80);
  if (part.text?.trim()) return clipInline(part.text, 80);
  if (part.url) return clipInline(part.url, 80);
  if (part.type === "diff") return clipInline(stringMetadata(part.metadata, "path") ?? "Diff 片段", 80);
  if (part.type === "deploy_status") return "部署状态";
  return part.type;
}

function partTypeLabel(part: HubMessagePartDto) {
  if (part.type === "code") return part.language ?? "code";
  if (part.type === "diff") return "diff";
  if (part.type === "artifact") return "artifact";
  if (part.type === "image") return "image";
  if (part.type === "file") return "file";
  if (part.type === "link_preview") return "link";
  if (part.type === "deploy_status") return "deploy";
  return "text";
}

function clipInline(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
}

function clipboardAttachmentFiles(data: DataTransfer | null) {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function ComposerAttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: UploadedAttachmentDto;
  onRemove: () => void;
}) {
  const image = attachment.mimeType.startsWith("image/");

  if (image) {
    return (
      <span className="attachmentCard imageAttachment" title={attachment.name}>
        <img alt={attachment.name} src={attachment.url} />
        <button type="button" title="移除附件" onClick={onRemove}>
          <CloseOutlined />
        </button>
      </span>
    );
  }

  return (
    <span className="attachmentCard fileAttachment" title={attachment.name}>
      <span className="attachmentFileIcon">
        <FileOutlined />
      </span>
      <span className="attachmentFileMeta">
        <strong>{attachment.name}</strong>
        <small>{formatBytes(attachment.sizeBytes)}</small>
      </span>
      <button type="button" title="移除附件" onClick={onRemove}>
        <CloseOutlined />
      </button>
    </span>
  );
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function mergeTimelinePage(detail: SessionDetailDto, page: SessionTimelinePageDto): SessionDetailDto {
  return {
    ...detail,
    messages: mergeById(detail.messages, page.messages).sort(sortMessage),
    runs: mergeById(detail.runs, page.runs).sort(sortRun),
    events: mergeById(detail.events, page.events).sort(sortEvent),
    artifacts: mergeById(detail.artifacts, page.artifacts).sort(sortArtifact),
    fileChanges: mergeById(detail.fileChanges, page.fileChanges).sort(sortFileChange),
    timelinePage: { hasMore: page.hasMore, nextCursor: page.nextCursor ?? null },
  };
}

function mergeById<T extends { id: string | number }>(current: T[], incoming: T[]) {
  let next = current;
  for (const item of incoming) {
    next = upsertById(next, item);
  }
  return next;
}

function currentUserDisplayName(user: AuthUserDto | null) {
  return user?.displayName?.trim() || user?.username || "我";
}

function readAvatarFile(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (!AVATAR_TYPES.has(file.type)) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function CapabilityTags({ capabilities }: { capabilities?: unknown[] }) {
  const labels = capabilityLabels(capabilities).slice(0, 3);
  if (labels.length === 0) return null;
  return (
    <span className="capabilityTags">
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </span>
  );
}

function capabilityLabels(capabilities: unknown[] | undefined) {
  if (!Array.isArray(capabilities)) return [];
  return capabilities
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const name = (item as Record<string, unknown>).name;
        return typeof name === "string" ? name.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
}
