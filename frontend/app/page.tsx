"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentInstanceDto,
  AgentTemplateDto,
  HubArtifactDto,
  HubContextSnapshotDto,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubRunDto,
  HubSessionDto,
  SessionDetailDto,
} from "@agenthub/shared";
import {
  ApiOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  DatabaseOutlined,
  FileDoneOutlined,
  FileMarkdownOutlined,
  LinkOutlined,
  LoadingOutlined,
  MessageOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  SendOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  artifactContentUrl,
  buildTimeline,
  cancelRun,
  connectHubSocket,
  createSession,
  getSessionDetail,
  listAgents,
  listAgentTemplates,
  listSessions,
  pinSessionMessage,
  sendSessionMessage,
  upsertById,
  type SocketState,
} from "../lib/agenthub-api";

type InspectorTab = "diff" | "artifacts" | "context";

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
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [composer, setComposer] = useState("");
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>([]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("diff");
  const [notice, setNotice] = useState("正在连接 AgentHub 后端");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const activeSession = detail?.session ?? sessions.find((session) => session.id === activeSessionId) ?? null;
  const latestRun = detail?.runs.at(-1) ?? activeSession?.lastRun ?? null;
  const orchestrator = agents.find((agent) => agent.isDefaultOrchestrator) ?? agents[0] ?? null;
  const workerAgents = agents.filter((agent) => !agent.isDefaultOrchestrator);
  const timeline = useMemo(
    () => buildTimeline(detail?.messages ?? [], detail?.events ?? []),
    [detail?.messages, detail?.events],
  );

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    const disconnect = connectHubSocket(activeSessionId, {
      onState: setSocketState,
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
  }, [timeline.length]);

  async function bootstrap() {
    const [agentRes, templateRes, sessionRes] = await Promise.all([listAgents(), listAgentTemplates(), listSessions()]);
    if (agentRes.ok) setAgents(agentRes.data.items);
    if (templateRes.ok) setTemplates(templateRes.data.items);

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
    setNotice("AgentHub 已就绪");
  }

  async function loadSession(sessionId: string) {
    setActiveSessionId(sessionId);
    const result = await getSessionDetail(sessionId);
    if (!result.ok) {
      setNotice(`会话加载失败：${result.error}`);
      return;
    }
    setDetail(result.data);
    setMentionedAgentIds([]);
  }

  async function handleCreateSession() {
    const result = await createSession({ title: "新 Agent 群聊" });
    if (!result.ok) {
      setNotice(`创建失败：${result.error}`);
      return;
    }
    setSessions((current) => [result.data, ...current]);
    setDetail({ session: result.data, ...EMPTY_DETAIL });
    setActiveSessionId(result.data.id);
    setMentionedAgentIds([]);
  }

  async function handleSend() {
    const text = composer.trim();
    if (!text || !activeSessionId || sending) return;
    setSending(true);
    setComposer("");
    try {
      const result = await sendSessionMessage(activeSessionId, {
        content: text,
        mentionedAgentIds,
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
      setMentionedAgentIds([]);
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

  function toggleMention(agentId: string) {
    setMentionedAgentIds((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    );
  }

  return (
    <main className="agenthubShell">
      <aside className="sessionRail">
        <div className="railHeader">
          <div>
            <strong>AgentHub</strong>
            <span>多 Agent 群聊</span>
          </div>
          <button className="iconButton" type="button" title="新建会话" onClick={() => void handleCreateSession()}>
            <PlusOutlined />
          </button>
        </div>

        <div className="statusStack">
          <StatusPill state={socketState} />
          <div className="miniMetric">
            <DatabaseOutlined />
            <span>PostgreSQL / pgvector</span>
          </div>
          <div className="miniMetric">
            <ApiOutlined />
            <span>{orchestrator?.name ?? "Orchestrator"}</span>
          </div>
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
              <small>{session.lastRun?.status ?? session.status} · {formatTime(session.updatedAt)}</small>
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
          {timeline.map((item) =>
            item.kind === "message" ? (
              <UserMessage key={item.id} message={item.message} onPin={handlePin} />
            ) : (
              <AgentEvent key={item.id} event={item.event} agents={agents} />
            ),
          )}
          {timeline.length === 0 && (
            <div className="emptyState">
              <TeamOutlined />
              <span>等待第一条任务</span>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <footer className="composer">
          <div className="mentionStrip">
            {workerAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`mentionChip ${mentionedAgentIds.includes(agent.id) ? "selected" : ""}`}
                onClick={() => toggleMention(agent.id)}
              >
                @{agent.name}
              </button>
            ))}
          </div>
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder="输入任务，@Agent 会随消息交给主 Orchestrator"
            disabled={sending || !activeSessionId}
          />
          <div className="composerBar">
            <span>{mentionedAgentIds.length ? `已选择 ${mentionedAgentIds.length} 个 Agent` : "默认由主 Orchestrator 协调"}</span>
            <button className="primaryButton" type="button" disabled={!composer.trim() || sending} onClick={() => void handleSend()}>
              {sending ? <LoadingOutlined /> : <SendOutlined />}
              <span>发送</span>
            </button>
          </div>
        </footer>
      </section>

      <aside className="inspector">
        <div className="inspectorTabs">
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

        {inspectorTab === "diff" && <DiffPanel changes={detail?.fileChanges ?? []} />}
        {inspectorTab === "artifacts" && <ArtifactPanel artifacts={detail?.artifacts ?? []} />}
        {inspectorTab === "context" && (
          <ContextPanel context={detail?.context ?? null} templates={templates} agents={agents} />
        )}
      </aside>
    </main>
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

function AgentEvent({ event, agents }: { event: HubEventDto; agents: AgentInstanceDto[] }) {
  const agent = agents.find((item) => item.id === event.speakerAgentId);
  const name = event.speakerName ?? agent?.name ?? "Orchestrator";
  const text = eventText(event);
  const variant = event.eventType.includes("failed")
    ? "danger"
    : event.eventType.includes("completed")
      ? "success"
      : event.eventType === "file.change" || event.eventType.startsWith("artifact")
        ? "artifact"
        : "normal";

  return (
    <article className={`timelineRow agentRow ${variant}`}>
      <span className="avatar" style={{ background: agentColor(event.speakerAgentId ?? name) }}>
        {initials(name)}
      </span>
      <div className="bubble agentBubble">
        <div className="bubbleMeta">
          <span>{name} · {formatTime(event.occurredAt ?? event.persistedAt)}</span>
          <code>{event.eventType}</code>
        </div>
        {event.eventType === "file.change" ? (
          <InlineDiff event={event} />
        ) : event.eventType.startsWith("artifact") ? (
          <InlineArtifact event={event} />
        ) : (
          <RichText text={text} />
        )}
      </div>
    </article>
  );
}

function DiffPanel({ changes }: { changes: HubFileChangeDto[] }) {
  if (changes.length === 0) return <PanelEmpty icon={<BranchesOutlined />} text="暂无文件变更" />;
  return (
    <div className="panelScroll">
      {changes.map((change) => (
        <details className="diffBlock" key={change.id} open>
          <summary>
            <span>{change.path}</span>
            <code>{change.changeType}</code>
          </summary>
          {change.patch ? (
            <pre className="patch">{change.patch}</pre>
          ) : (
            <div className="splitDiff">
              <pre>{change.beforeContent ?? ""}</pre>
              <pre>{change.afterContent ?? ""}</pre>
            </div>
          )}
        </details>
      ))}
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
              <small>{artifact.kind} · v{artifact.version} · {artifact.final ? "final" : "draft"}</small>
            </div>
            <a title="打开内容" href={artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
              <LinkOutlined />
            </a>
          </div>
          {artifact.textContent ? <RichText text={artifact.textContent} /> : <code>{artifact.storageUri ?? "inline"}</code>}
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
            <code>{agent.template?.agentKind ?? "worker"}</code>
          </div>
        ))}
        <strong>模板</strong>
        {templates.map((template) => (
          <div key={template.id}>
            <span>{template.name}</span>
            <code>{template.agentKind}</code>
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
      {patch ? <pre className="patch">{patch}</pre> : <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
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

function RichText({ text }: { text: string }) {
  if (!text) return null;
  const blocks = text.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return (
    <div className="richText">
      {blocks.map((block, index) => {
        if (block.startsWith("```")) {
          return <pre key={index}>{block.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/```$/, "")}</pre>;
        }
        return block.split(/\n+/).map((line, lineIndex) => {
          if (line.startsWith("# ")) return <h3 key={`${index}-${lineIndex}`}>{line.slice(2)}</h3>;
          if (line.startsWith("- ")) return <p className="listLine" key={`${index}-${lineIndex}`}>{line}</p>;
          return <p key={`${index}-${lineIndex}`}>{line}</p>;
        });
      })}
    </div>
  );
}

function StatusPill({ state }: { state: SocketState }) {
  const icon = state === "connected" ? <CheckCircleOutlined /> : state === "connecting" ? <LoadingOutlined /> : <CloseCircleOutlined />;
  return (
    <div className={`socketPill ${state}`}>
      {icon}
      <span>{state}</span>
    </div>
  );
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
