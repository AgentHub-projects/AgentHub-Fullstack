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
type TeamStatus = "online" | "working" | "idle" | "done" | "error";

type TeamMember = {
  id: string;
  name: string;
  shortName: string;
  role: string;
  provider: string;
  status: TeamStatus;
  accent: string;
};

const singleAgents = [
  {
    id: "claude-cli-agent",
    name: "Claude CLI",
    provider: "Claude Code",
    role: "本地代码执行与修复",
  },
  {
    id: "local-cli-agent",
    name: "Local CLI",
    provider: "PowerShell",
    role: "本地命令与验证",
  },
];

const teamMembers: TeamMember[] = [
  {
    id: "orchestrator-agent",
    name: "Orchestrator",
    shortName: "OR",
    role: "拆解任务 / 汇总进度",
    provider: "Controller",
    status: "online",
    accent: "#6f5bd7",
  },
  {
    id: "frontend-agent",
    name: "Frontend",
    shortName: "FE",
    role: "Next.js UI / 状态接线",
    provider: "Claude CLI",
    status: "working",
    accent: "#1677ff",
  },
  {
    id: "backend-agent",
    name: "Backend",
    shortName: "BE",
    role: "API / Socket",
    provider: "Node runtime",
    status: "idle",
    accent: "#12a37f",
  },
  {
    id: "review-agent",
    name: "Review",
    shortName: "RV",
    role: "契约与回归检查",
    provider: "Reviewer",
    status: "idle",
    accent: "#d46b08",
  },
  {
    id: "test-agent",
    name: "Test",
    shortName: "TS",
    role: "typecheck / build",
    provider: "CI local",
    status: "idle",
    accent: "#0f766e",
  },
  {
    id: "merge-agent",
    name: "Merge",
    shortName: "MG",
    role: "提交 / 分支同步",
    provider: "Git",
    status: "idle",
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
    teamMembers.find((agent) => agent.id === agentId) ??
    teamMembers.find((agent) => agent.id === "orchestrator-agent") ??
    teamMembers[0]
  );
}

export default function WorkbenchPage() {
  const [session, setSession] = useState<SessionDto>(initialSession);
  const [events, setEvents] = useState<AgentEvent[]>(initialEvents);
  const [prompt, setPrompt] = useState("请执行 P0 smoke test 并返回结果摘要");
  const [selectedAgentId, setSelectedAgentId] = useState(singleAgents[0].id);
  const [notice, setNotice] = useState("后端未返回前使用本地占位数据。");
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(
    initialSession.runIds.at(-1) ?? null,
  );

  const latestEvent = events.at(-1);
  const selectedAgent =
    singleAgents.find((agent) => agent.id === selectedAgentId) ??
    singleAgents[0];
  const isRunning = session.status === "running" || isSubmitting;
  const visibleRunIds = session.runIds.length > 0 ? session.runIds : ["无"];

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
      ["SessionDto.id", session.id],
      ["SessionDto.status", session.status],
      ["SessionDto.agentId", session.agentId ?? selectedAgent.id],
      ["SessionDto.output", session.output ?? "未生成"],
      ["SessionDto.error", session.error ?? "无"],
      ["runIds", visibleRunIds.join(", ")],
      ["currentRunId", currentRunId ?? "等待后端返回"],
      ["testSync.status", session.testSync?.status ?? "pending"],
      ["testSync.targetBranch", session.testSync?.targetBranch ?? "main"],
      ["testSync.summaryPath", session.testSync?.summaryPath ?? "未返回"],
      ["AgentEvent.type", latestEvent?.type ?? "无事件"],
      ["AgentEvent.payload", latestEvent ? "已接收" : "无"],
    ],
    [currentRunId, latestEvent, selectedAgent.id, session, visibleRunIds],
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
          setCurrentRunId((current) => {
            const latestRunId = result.data.session?.runIds.at(-1);
            return current ?? latestRunId ?? null;
          });
        }
        if (result.data.events.length > 0) {
          setEvents(result.data.events);
        }
        setNotice("已从 GET /api/session/current 同步。");
      } else {
        setNotice(`GET /api/session/current 不可用：${result.error}`);
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
      setNotice("请输入测试口令。");
      return;
    }

    setIsSubmitting(true);
    setCurrentRunId(null);
    setSession((current) => ({
      ...current,
      agentId: selectedAgent.id,
      status: "running",
      prompt: value,
      updatedAt: new Date().toISOString(),
    }));

    const result = await runSession(value);
    setIsSubmitting(false);

    if (result.ok) {
      setSession(result.data.session);
      setCurrentRunId(result.data.run.id);
      setNotice("已调用 POST /api/session/run。");
      return;
    }

    setNotice(`POST /api/session/run 不可用：${result.error}`);
  }

  async function handleCancel() {
    if (!currentRunId) {
      setNotice("暂无可取消的 runId，等待后端返回 RunSessionResponse.run.id。");
      return;
    }

    setIsCancelling(true);
    const result = await cancelAgentRun(currentRunId);
    setIsCancelling(false);

    if (result.ok) {
      setSession(result.data.session);
      setCurrentRunId(result.data.run.id);
      setNotice("已发送 Cancel 请求。");
      return;
    }

    setSession((current) => ({
      ...current,
      status: "failed",
      error: `Cancel 请求失败：${result.error}`,
      updatedAt: new Date().toISOString(),
    }));
    setNotice(`Cancel 请求不可用：${result.error}`);
  }

  return (
    <main className="workspaceShell">
      <aside className="leftRail" aria-label="会话与 Agent">
        <div className="brandBlock">
          <span className="brandGlyph">A</span>
          <div>
            <strong>AgentHub</strong>
            <span>Lobe-style Workspace</span>
          </div>
        </div>

        <section className="railSection">
          <div className="sectionHeader">
            <span>Sessions</span>
            <span className={`statusDot ${session.status}`} />
          </div>
          <button className="sessionCard active" type="button">
            <span>{session.title ?? "Current Session"}</span>
            <small>
              {statusLabel(session.status)} · {session.runIds.length} runs
            </small>
          </button>
          <button className="sessionCard quiet" type="button">
            <span>Agent Team Preview</span>
            <small>前端派生视图 · 不触发编排</small>
          </button>
        </section>

        <section className="railSection">
          <div className="sectionHeader">
            <span>Single Agent</span>
            <small>{selectedAgent.provider}</small>
          </div>
          <div className="agentSwitch">
            {singleAgents.map((agent) => (
              <button
                className={agent.id === selectedAgentId ? "selected" : ""}
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                type="button"
              >
                <strong>{agent.name}</strong>
                <small>{agent.role}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="railSection">
          <div className="sectionHeader">
            <span>Agent Team</span>
            <small>{teamMembers.length}</small>
          </div>
          <div className="teamRoster">
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
                <i className={agent.status}>{agent.status}</i>
              </div>
            ))}
          </div>
        </section>
      </aside>

      <section className="chatWorkbench" aria-label="聊天线程">
        <header className="chatHeader">
          <div>
            <span className="eyebrow">Session #{session.id}</span>
            <h1>{session.prompt ?? "输入测试口令启动会话"}</h1>
          </div>
          <div className="headerBadges">
            <span className={`socketBadge ${socketState}`}>
              Socket {socketState}
            </span>
            <span className={`runBadge ${session.status}`}>
              {statusLabel(session.status)}
            </span>
            <time>{formatTime(session.updatedAt)}</time>
          </div>
        </header>

        <div className="threadPane">
          <article className="messageRow userMessage">
            <div className="messageBubble">
              <span className="messageMeta">User Prompt</span>
              <p>{session.prompt}</p>
            </div>
          </article>

          <article className={`messageRow assistantMessage ${session.status}`}>
            <div className="assistantAvatar">{selectedAgent.name.slice(0, 2)}</div>
            <div className="messageBubble">
              <span className="messageMeta">
                {selectedAgent.name} · {session.status}
              </span>
              <p>{session.output ?? "等待 agent 输出或 streaming delta..."}</p>
              {session.error ? <pre>{session.error}</pre> : null}
            </div>
          </article>

          <section className="groupThread" aria-label="Agent group events">
            <div className="groupTitle">
              <span>Agent Group Events</span>
              <small>按 agent 聚合展示事件流</small>
            </div>
            {eventGroups.map((group) => (
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
            ))}
          </section>
        </div>

        <footer className="composer">
          <textarea
            aria-label="测试口令"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="输入测试口令..."
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

      <aside className="inspectorPanel" aria-label="运行检查器">
        <section className="inspectorSection heroStatus">
          <div className="sectionHeader">
            <span>Run Inspector</span>
            <small>{session.status}</small>
          </div>
          <strong>{statusLabel(session.status)}</strong>
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
            <small>路径</small>
          </div>
          <div className="artifactList">
            <div>
              <span>Log path</span>
              <strong>backend session events / socket stream</strong>
            </div>
            <div>
              <span>Summary</span>
              <strong>{session.testSync?.summaryPath ?? "未返回 summaryPath"}</strong>
            </div>
            <div>
              <span>Target branch</span>
              <strong>{session.testSync?.targetBranch ?? "main"}</strong>
            </div>
          </div>
        </section>

        <section className="inspectorSection commandHints">
          <div className="sectionHeader">
            <span>Mode Hints</span>
            <small>只读提示</small>
          </div>
          <div className="hintGrid">
            <span>Selected</span>
            <strong>{selectedAgent.name}</strong>
            <span>Command</span>
            <strong>pnpm --filter @agenthub/frontend typecheck</strong>
            <span>Mode</span>
            <strong>single-chat + static group view</strong>
          </div>
        </section>
      </aside>
    </main>
  );
}
