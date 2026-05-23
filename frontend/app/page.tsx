"use client";

import { useEffect, useMemo, useState } from "react";
import type { AgentEvent, SessionDto } from "@agenthub/shared";
import {
  cancelSession,
  connectSessionSocket,
  getCurrentSession,
  initialEvents,
  initialSession,
  runSession,
} from "../lib/agenthub-api";

type SocketState = "connecting" | "connected" | "disconnected" | "unavailable";

const agents = [
  {
    id: "frontend-agent",
    name: "Frontend Agent",
    role: "Next.js TS",
    status: "running",
  },
  {
    id: "backend-agent",
    name: "Backend Agent",
    role: "API / Socket",
    status: "idle",
  },
  {
    id: "review-agent",
    name: "Review Agent",
    role: "Contract check",
    status: "idle",
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
    idle: "idle",
    running: "running",
    succeeded: "succeeded",
    failed: "failed",
  };
  return labels[status];
}

function stringifyPayload(payload: unknown) {
  if (typeof payload === "string") {
    return payload;
  }

  return JSON.stringify(payload, null, 2);
}

export default function WorkbenchPage() {
  const [session, setSession] = useState<SessionDto>(initialSession);
  const [events, setEvents] = useState<AgentEvent[]>(initialEvents);
  const [prompt, setPrompt] = useState("请执行 P0 smoke test 并返回结果摘要");
  const [notice, setNotice] = useState("后端未返回前使用本地占位数据。");
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const latestEvent = events.at(-1);
  const isRunning = session.status === "running" || isSubmitting;

  const contractFields = useMemo(
    () => [
      ["SessionDto.status", session.status],
      ["SessionDto.output", session.output ?? "未生成"],
      ["SessionDto.error", session.error ?? "无"],
      ["testSync.status", session.testSync?.status ?? "pending"],
      ["testSync.targetBranch", session.testSync?.targetBranch ?? "main"],
      ["AgentEvent.type", latestEvent?.type ?? "无事件"],
      ["AgentEvent.payload", latestEvent ? "已接收" : "无"],
    ],
    [latestEvent, session],
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
  }, []);

  async function handleRun() {
    const value = prompt.trim();
    if (!value) {
      setNotice("请输入测试口令。");
      return;
    }

    setIsSubmitting(true);
    setSession((current) => ({
      ...current,
      status: "running",
      prompt: value,
      updatedAt: new Date().toISOString(),
    }));

    const result = await runSession(value);
    setIsSubmitting(false);

    if (result.ok) {
      setSession(result.data);
      setNotice("已调用 POST /api/session/run。");
      return;
    }

    setNotice(`POST /api/session/run 不可用：${result.error}`);
  }

  async function handleCancel() {
    setIsCancelling(true);
    const result = await cancelSession();
    setIsCancelling(false);

    if (result.ok) {
      setSession(result.data);
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
    <main className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brandMark">AH</span>
          <div>
            <strong>AgentHub</strong>
            <span>P0 Workbench</span>
          </div>
        </div>

        <section className="panelSection">
          <div className="sectionHeader">
            <span>会话</span>
            <span className={`dot ${session.status}`} />
          </div>
          <button className="conversation active" type="button">
            <span>{session.title ?? "Current Session"}</span>
            <small>{statusLabel(session.status)} · {session.runIds.length} runs</small>
          </button>
        </section>

        <section className="panelSection">
          <div className="sectionHeader">
            <span>Agents</span>
            <small>{agents.length}</small>
          </div>
          <div className="agentList">
            {agents.map((agent) => (
              <button className="agentItem" key={agent.id} type="button">
                <span className="avatar">{agent.name.slice(0, 2)}</span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.role}</small>
                </span>
                <i className={agent.status} />
              </button>
            ))}
          </div>
        </section>
      </aside>

      <section className="thread">
        <header className="topbar">
          <div>
            <p>Session #{session.id}</p>
            <h1>{session.prompt ?? "输入测试口令启动会话"}</h1>
          </div>
          <div className="topbarMeta">
            <span className={`socket ${socketState}`}>Socket {socketState}</span>
            <span>{formatTime(session.updatedAt)}</span>
          </div>
        </header>

        <div className="messagePane">
          <article className="message user">
            <span>Test Prompt</span>
            <p>{session.prompt}</p>
          </article>

          <article className={`message agent ${session.status}`}>
            <span>SessionDto · {session.status}</span>
            <p>{session.output ?? "等待 agent 输出..."}</p>
            {session.error ? <pre>{session.error}</pre> : null}
          </article>

          {events.map((event) => (
            <article className="eventCard" key={event.eventId}>
              <div>
                <strong>{event.type}</strong>
                <span>seq {event.seq} · {formatTime(event.ts)}</span>
              </div>
              <pre>{stringifyPayload(event.payload)}</pre>
            </article>
          ))}
        </div>

        <footer className="composer">
          <textarea
            aria-label="测试口令"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="输入测试口令..."
            value={prompt}
          />
          <div className="composerActions">
            <span>{notice}</span>
            <div>
              <button
                className="secondary"
                disabled={!isRunning || isCancelling}
                onClick={handleCancel}
                type="button"
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

      <aside className="inspector">
        <section>
          <div className="sectionHeader">
            <span>Run Inspector</span>
            <small>{session.status}</small>
          </div>
          <dl className="kv">
            {contractFields.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="previewCard">
          <div className="sectionHeader">
            <span>Preview</span>
            <small>placeholder</small>
          </div>
          <div className="previewBox">
            <span>UI Preview</span>
            <strong>{session.status}</strong>
            <p>后端 preview_card 事件接入后在此展示实际预览。</p>
          </div>
        </section>

        <section className="diffCard">
          <div className="sectionHeader">
            <span>Diff</span>
            <small>placeholder</small>
          </div>
          <pre>{`+ frontend/app/page.tsx\n+ frontend/lib/agenthub-api.ts\n~ waiting for code_diff event`}</pre>
        </section>
      </aside>
    </main>
  );
}
