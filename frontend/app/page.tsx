"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { AgentEvent, SessionDto } from "@agenthub/shared";
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

type TeamMember = {
  id: string;
  name: string;
  shortName: string;
  role: string;
  provider: string;
  status: TeamStatus;
  accent: string;
};

const DEFAULT_PROMPT = "帮我写一个前后端分离的架构的todolist系统。";

const claudeAgent = {
  id: "claude-code-agent",
  name: "Claude Code",
  provider: "Claude Code agent",
  role: "单聊执行入口 / 真实 run 状态",
};

const teamMembers: TeamMember[] = [
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
  if (typeof payload === "string") {
    return payload;
  }

  return JSON.stringify(payload, null, 2);
}

function payloadSummary(event: AgentEvent) {
  if (typeof event.payload === "string") {
    return event.payload;
  }

  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as Record<string, unknown>;
    const message = payload.message ?? payload.title ?? payload.status;
    if (typeof message === "string") {
      return message;
    }
  }

  return event.type.replace(/_/g, " ");
}

function getAgentMeta(agentId: string) {
  return (
    teamMembers.find((agent) => agent.id === agentId) ?? {
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

export default function WorkbenchPage() {
  const [session, setSession] = useState<SessionDto>(initialSession);
  const [events, setEvents] = useState<AgentEvent[]>(initialEvents);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [notice, setNotice] = useState(
    "尚未确认后端连接；当前不会展示 mock 成功结果。",
  );
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);

  const latestEvent = events.at(-1);
  const isRunning = session.status === "running" || isSubmitting;
  const hasBackendSession = session.id !== initialSession.id;
  const visibleRunIds =
    session.runIds.length > 0 ? session.runIds.join(", ") : "后端暂未返回 runId";

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

      groups.push({
        agent,
        events: [event],
        key: `${agent.id}-${event.eventId}`,
      });
      return groups;
    }, []);
  }, [events]);

  const contractFields = useMemo(
    () => [
      ["GET", "/api/session/current"],
      ["POST", "/api/session/run"],
      ["POST", "/api/agent-runs/:runId/cancel"],
      ["Socket", "AgentEvent / agent:event / session:event"],
      ["SessionDto.id", session.id],
      ["SessionDto.status", session.status],
      ["SessionDto.agentId", session.agentId ?? claudeAgent.id],
      ["SessionDto.output", session.output ?? "无后端输出"],
      ["SessionDto.error", session.error ?? "无"],
      ["SessionDto.runIds", visibleRunIds],
      ["RunSessionResponse.run.id", currentRunId ?? "等待后端返回"],
      ["testSync.status", session.testSync?.status ?? "pending"],
      ["testSync.targetBranch", session.testSync?.targetBranch ?? "main"],
      ["testSync.summaryPath", session.testSync?.summaryPath ?? "未返回"],
      ["AgentEvent.type", latestEvent?.type ?? "无事件"],
      ["AgentEvent.payload", latestEvent ? "已接收" : "无"],
    ],
    [currentRunId, latestEvent, session, visibleRunIds],
  );

  useEffect(() => {
    let ignore = false;

    async function refresh() {
      const result = await getCurrentSession();
      if (ignore) {
        return;
      }

      if (result.ok) {
        if (result.data.session) {
          setSession(result.data.session);
          const latestRunId = result.data.session.runIds.at(-1) ?? null;
          setCurrentRunId((current) => current ?? latestRunId);
        }
        setEvents(result.data.events);
        setNotice("已从 GET /api/session/current 同步真实会话。");
      } else {
        setNotice(`后端未连接：GET /api/session/current ${result.error}`);
      }
    }

    void refresh();
    const timer = window.setInterval(refresh, 3500);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const disconnect = connectSessionSocket(
      session.id,
      (event) => {
        setEvents((current) => {
          if (current.some((item) => item.eventId === event.eventId)) {
            return current;
          }
          return [...current, event].sort((a, b) => a.seq - b.seq);
        });
      },
      (state) => setSocketState(state),
    );

    return disconnect;
  }, [session.id]);

  async function handleRun() {
    const value = prompt.trim();
    if (!value) {
      setNotice("请输入口令。");
      return;
    }

    setIsSubmitting(true);
    setCurrentRunId(null);
    setNotice("正在调用 POST /api/session/run，等待后端返回真实 run。");

    const result = await runSession(value);
    setIsSubmitting(false);

    if (result.ok) {
      setSession(result.data.session);
      setCurrentRunId(result.data.run.id);
      setNotice("已启动真实 Claude Code agent run。");
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
            <span>Lobe-like workbench</span>
          </div>
          <span className={`statusPill ${session.status}`}>
            {statusLabel(session.status)}
          </span>
        </section>

        <section className="panelBlock">
          <div className="sectionHeader">
            <span>Sessions</span>
            <small>{hasBackendSession ? "API" : "offline"}</small>
          </div>
          <button className="sessionCard active" type="button">
            <span>{session.title ?? "Current Session"}</span>
            <small>{session.id}</small>
          </button>
          <button className="sessionCard muted" type="button">
            <span>Agent team 状态视图</span>
            <small>只展示前端状态，不伪造后端多 agent 调度</small>
          </button>
        </section>

        <section className="panelBlock">
          <div className="sectionHeader">
            <span>Single Chat Agent</span>
            <small>{claudeAgent.provider}</small>
          </div>
          <div className="agentCard selected">
            <span className="agentAvatar">CC</span>
            <div>
              <strong>{claudeAgent.name}</strong>
              <small>{claudeAgent.role}</small>
            </div>
          </div>
        </section>

        <section className="panelBlock teamBlock">
          <div className="sectionHeader">
            <span>Group Status</span>
            <small>frontend view</small>
          </div>
          {teamMembers.map((agent) => (
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
            <span className="eyebrow">Claude Code agent / Session {session.id}</span>
            <h1>{session.prompt ?? DEFAULT_PROMPT}</h1>
          </div>
          <div className="headerBadges">
            <span className={`socketBadge ${socketState}`}>
              Socket {socketState}
            </span>
            <span className={`runBadge ${session.status}`}>
              {isSubmitting ? "请求中" : statusLabel(session.status)}
            </span>
            <time>{formatTime(session.updatedAt)}</time>
          </div>
        </header>

        <div className="threadPane">
          <article className="messageRow userMessage">
            <div className="messageBubble">
              <span className="messageMeta">User Prompt</span>
              <p>{session.prompt ?? prompt}</p>
            </div>
          </article>

          <article className={`messageRow assistantMessage ${session.status}`}>
            <div className="assistantAvatar">CC</div>
            <div className="messageBubble">
              <span className="messageMeta">
                Claude Code agent · {isSubmitting ? "请求中" : statusLabel(session.status)}
              </span>
              {session.output ? (
                <p>{session.output}</p>
              ) : (
                <p className="emptyCopy">
                  {isSubmitting
                    ? "请求已发出，等待后端创建 run 与事件流。"
                    : "暂无后端输出。连接后端并启动 run 后，这里只展示真实返回内容。"}
                </p>
              )}
              {session.error ? <pre>{session.error}</pre> : null}
            </div>
          </article>

          <section className="groupThread" aria-label="群聊事件流">
            <div className="groupTitle">
              <span>Group Event Stream</span>
              <small>真实 Socket AgentEvent；无事件时为空态</small>
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
                      <details className="eventCard" key={event.eventId} open>
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
              <div className="emptyEvents">
                <strong>暂无 AgentEvent</strong>
                <span>
                  群聊区域只渲染后端 Socket 或 GET /api/session/current 返回的真实事件。
                </span>
              </div>
            )}
          </section>
        </div>

        <footer className="composer">
          <textarea
            aria-label="默认任务口令"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="输入任务口令..."
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
            <span>Artifacts</span>
            <small>API data only</small>
          </div>
          <div className="artifactList">
            <div>
              <span>Events</span>
              <strong>{events.length} AgentEvent records</strong>
            </div>
            <div>
              <span>Summary</span>
              <strong>{session.testSync?.summaryPath ?? "后端未返回 summaryPath"}</strong>
            </div>
            <div>
              <span>Target branch</span>
              <strong>{session.testSync?.targetBranch ?? "main"}</strong>
            </div>
          </div>
        </section>

        <section className="inspectorSection notePanel">
          <div className="sectionHeader">
            <span>Boundary</span>
            <small>no mock success</small>
          </div>
          <p>
            群聊列表是前端状态视图；实际运行、取消和事件内容均来自后端 API 或 Socket。
          </p>
        </section>
      </aside>
    </main>
  );
}
