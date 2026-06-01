"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTemplateDto,
  BuildMessageDto,
  BuildSessionDto,
  BuildSessionListItemDto,
  BuildTemplateDraft,
} from "@agenthub/shared";
import {
  CheckCircleOutlined,
  LeftOutlined,
  LoadingOutlined,
  PlusOutlined,
  SendOutlined,
} from "@ant-design/icons";
import {
  confirmBuild,
  getBuildMessages,
  getBuildSession,
  listBuildSessions,
  sendBuildMessage,
  startBuild,
} from "../../../lib/agenthub-api";
import { RichText } from "../../workbench/rich-text";

const EMPTY_DRAFT: BuildTemplateDraft = {
  name: "",
  description: "",
  systemPrompt: "",
  defaultProvider: "",
  tools: [],
};

export default function AgentTemplateBuildPage() {
  const [sessions, setSessions] = useState<BuildSessionListItemDto[]>([]);
  const [activeBuildId, setActiveBuildId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<BuildSessionDto | null>(null);
  const [messages, setMessages] = useState<BuildMessageDto[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("正在加载创建历史");
  const [options, setOptions] = useState<string[]>([]);
  const [draft, setDraft] = useState<BuildTemplateDraft | null>(null);
  const [createdTemplate, setCreatedTemplate] = useState<AgentTemplateDto | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const readonly = activeSession?.status === "completed";
  const activeHistoryItem = sessions.find((item) => item.id === activeBuildId) ?? null;
  const previewDraft = draft ?? draftFromContext(activeSession?.context) ?? EMPTY_DRAFT;
  const hasDraft = Boolean(draft ?? draftFromContext(activeSession?.context));

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, draft?.name]);

  async function bootstrap() {
    const result = await listBuildSessions();
    if (!result.ok) {
      setNotice(`历史加载失败：${result.error}`);
      return;
    }
    setSessions(result.data.items);
    setNotice(result.data.items.length > 0 ? "选择历史或新建一个模板创建对话" : "描述你想创建的 Agent 模板");
    const firstActive = result.data.items.find((item) => item.status === "active") ?? result.data.items[0];
    if (firstActive) {
      await loadBuild(firstActive.id);
    }
  }

  async function refreshHistory(selectId?: string) {
    const result = await listBuildSessions();
    if (!result.ok) {
      setNotice(`历史刷新失败：${result.error}`);
      return;
    }
    setSessions(result.data.items);
    if (selectId) setActiveBuildId(selectId);
  }

  async function loadBuild(buildId: string) {
    setBusy(true);
    setNotice("正在加载创建对话");
    try {
      const [sessionResult, messageResult] = await Promise.all([
        getBuildSession(buildId),
        getBuildMessages(buildId),
      ]);
      if (!sessionResult.ok) {
        setNotice(`创建会话加载失败：${sessionResult.error}`);
        return;
      }
      if (!messageResult.ok) {
        setNotice(`消息加载失败：${messageResult.error}`);
        return;
      }
      setActiveBuildId(buildId);
      setActiveSession(sessionResult.data);
      setMessages(messageResult.data);
      const latest = latestAssistantState(messageResult.data, sessionResult.data);
      setOptions(sessionResult.data.status === "completed" ? [] : latest.options);
      setDraft(latest.draft);
      setCreatedTemplate(null);
      setInput("");
      setNotice(sessionResult.data.status === "completed" ? "已完成，只读回看" : "可以继续创建这个 Agent 模板");
    } finally {
      setBusy(false);
    }
  }

  function startNewBuild() {
    setActiveBuildId(null);
    setActiveSession(null);
    setMessages([]);
    setOptions([]);
    setDraft(null);
    setCreatedTemplate(null);
    setInput("");
    setNotice("用一句话描述你想创建的 Agent 模板");
  }

  async function submitBuildMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || busy || readonly) return;

    setInput("");
    setOptions([]);
    setBusy(true);

    const pendingUserMessage: BuildMessageDto = {
      id: `temp-${Date.now()}`,
      buildSessionId: activeBuildId ?? "",
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };

    try {
      if (!activeBuildId) {
        setMessages([pendingUserMessage]);
        const result = await startBuild({ description: text });
        if (!result.ok) {
          setNotice(`Builder 错误：${result.error}`);
          return;
        }
        setActiveBuildId(result.data.buildId);
        setActiveSession({
          id: result.data.buildId,
          status: "active",
          context: {},
          agentTemplateId: null,
          createdAt: result.data.userMessage.createdAt,
          updatedAt: result.data.message.createdAt,
        });
        setMessages([result.data.userMessage, result.data.message]);
        setOptions(result.data.message.options ?? []);
        setDraft(result.data.message.draft ?? null);
        setNotice("继续通过选项或输入完善模板");
        await refreshHistory(result.data.buildId);
        return;
      }

      setMessages((current) => [...current, pendingUserMessage]);
      const result = await sendBuildMessage(activeBuildId, { message: text });
      if (!result.ok) {
        setNotice(`Builder 错误：${result.error}`);
        return;
      }
      setMessages((current) => [
        ...current.slice(0, -1),
        result.data.userMessage,
        result.data.message,
      ]);
      setOptions(result.data.message.options ?? []);
      setDraft(result.data.message.draft ?? null);
      setNotice(result.data.message.draft ? "模板草稿已生成" : "继续通过选项或输入完善模板");
      await refreshHistory(activeBuildId);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDraft() {
    if (!activeBuildId || !draft || busy || readonly) return;
    setBusy(true);
    try {
      const result = await confirmBuild(activeBuildId, draft);
      if (!result.ok) {
        setNotice(`创建失败：${result.error}`);
        return;
      }
      setCreatedTemplate(result.data.template);
      setOptions([]);
      setNotice(`模板 "${result.data.template.name}" 创建成功`);
      const sessionResult = await getBuildSession(activeBuildId);
      if (sessionResult.ok) {
        setActiveSession(sessionResult.data);
      } else {
        setActiveSession((current) =>
          current ? { ...current, status: "completed", agentTemplateId: result.data.template.id } : current,
        );
      }
      await refreshHistory(activeBuildId);
    } finally {
      setBusy(false);
    }
  }

  const sessionCounts = useMemo(() => {
    const active = sessions.filter((item) => item.status === "active").length;
    const completed = sessions.filter((item) => item.status === "completed").length;
    return { active, completed };
  }, [sessions]);

  return (
    <main className="builderShell">
      <aside className="builderHistoryRail">
        <div className="builderRailTop">
          <button
            className="ghostButton builderBackButton"
            type="button"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            <LeftOutlined />
            <span>工作台</span>
          </button>
          <button className="primaryButton builderNewButton" type="button" onClick={startNewBuild}>
            <PlusOutlined />
            <span>新建模板</span>
          </button>
        </div>

        <section className="builderHistorySummary">
          <strong>Agent 模板创建</strong>
          <span>{sessionCounts.active} 个进行中 · {sessionCounts.completed} 个已完成</span>
        </section>

        <nav className="builderHistoryList" aria-label="创建历史">
          {sessions.length === 0 && (
            <div className="builderHistoryEmpty">暂无历史，先从一句需求开始。</div>
          )}
          {sessions.map((item) => (
            <button
              key={item.id}
              className={`builderHistoryItem ${item.id === activeBuildId ? "active" : ""}`}
              type="button"
              onClick={() => void loadBuild(item.id)}
            >
              <span>{item.title}</span>
              <small>
                {statusText(item.status)} · {formatShortTime(item.updatedAt)} · {item.messageCount} 条
              </small>
            </button>
          ))}
        </nav>
      </aside>

      <section className="builderConversationPane">
        <header className="builderConversationHeader">
          <div>
            <strong>{activeHistoryItem?.title ?? "新的 Agent 模板"}</strong>
            <span>{notice}</span>
          </div>
          {activeSession && <span className={`builderStatusPill ${activeSession.status}`}>{statusText(activeSession.status)}</span>}
        </header>

        <div className="builderConversationScroll">
          {messages.length === 0 && (
            <div className="builderStartPanel">
              <strong>先告诉我这个 Agent 要负责什么</strong>
              <span>后续问题会给出候选项，也可以随时自己输入补充。</span>
            </div>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`builderChatMessage ${message.role}`}>
              <div className="builderMessageMeta">{message.role === "user" ? "你" : "Builder"}</div>
              <RichText text={message.content} />
            </article>
          ))}
          <div ref={endRef} />
        </div>

        <footer className="builderComposer">
          {readonly && (
            <div className="builderReadonlyNotice">这个创建对话已完成，只能回看历史。</div>
          )}
          {options.length > 0 && !busy && !readonly && (
            <div className="builderOptionBar">
              {options.map((option) => (
                <button key={option} className="optionChip" type="button" onClick={() => void submitBuildMessage(option)}>
                  {option}
                </button>
              ))}
            </div>
          )}
          <div className="builderComposerRow">
            <input
              value={input}
              disabled={busy || readonly}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && input.trim() && !busy && !readonly) {
                  event.preventDefault();
                  void submitBuildMessage(input);
                }
              }}
              placeholder={activeBuildId ? "继续补充或改写需求..." : "例如：我想创建一个前端代码审查 Agent"}
            />
            <button
              className="primaryButton"
              type="button"
              disabled={!input.trim() || busy || readonly}
              onClick={() => void submitBuildMessage(input)}
            >
              {busy ? <LoadingOutlined /> : <SendOutlined />}
              <span>发送</span>
            </button>
          </div>
        </footer>
      </section>

      <aside className="builderPreviewPane">
        <section className="builderPreviewHeader">
          <div>
            <strong>模板预览</strong>
            <span>{createdTemplate ? "已创建" : hasDraft ? "待确认" : "等待草稿"}</span>
          </div>
          {createdTemplate && <CheckCircleOutlined />}
        </section>

        <section className="builderDraftCard">
          <Field label="名称" value={previewDraft.name || "尚未生成"} />
          <Field label="Provider" value={previewDraft.defaultProvider || "尚未选择"} code />
          <Field label="工具集" value={previewDraft.tools.length ? previewDraft.tools.join(", ") : "尚未配置"} code />
          <Field label="描述" value={previewDraft.description || "Builder 会根据你的选择生成用途描述。"} />
          <div className="builderDraftField">
            <span>System Prompt</span>
            <pre>{previewDraft.systemPrompt || "等待生成行为提示词。"}</pre>
          </div>
        </section>

        <section className="builderPreviewActions">
          {createdTemplate ? (
            <div className="builderSuccessBox">
              <strong>{createdTemplate.name}</strong>
              <span>模板 ID #{createdTemplate.id} 已保存，可回到工作台邀请到群聊。</span>
            </div>
          ) : (
            <button
              className="primaryButton"
              type="button"
              disabled={!draft || busy || readonly}
              onClick={() => void confirmDraft()}
            >
              确认创建模板
            </button>
          )}
        </section>
      </aside>
    </main>
  );
}

function Field({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return (
    <div className="builderDraftField">
      <span>{label}</span>
      {code ? <code>{value}</code> : <strong>{value}</strong>}
    </div>
  );
}

function latestAssistantState(messages: BuildMessageDto[], session: BuildSessionDto) {
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return {
    options: latestAssistant?.options ?? [],
    draft: latestAssistant?.draft ?? draftFromContext(session.context),
  };
}

function draftFromContext(context: Record<string, unknown> | undefined): BuildTemplateDraft | null {
  if (!context) return null;
  const draft = {
    name: stringValue(context.name),
    description: stringValue(context.description),
    systemPrompt: stringValue(context.systemPrompt),
    defaultProvider: stringValue(context.defaultProvider),
    tools: stringArrayValue(context.tools),
  };
  return draft.name && draft.description && draft.systemPrompt && draft.defaultProvider ? draft : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusText(status: string) {
  if (status === "completed") return "已完成";
  if (status === "cancelled") return "已取消";
  return "进行中";
}

function formatShortTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
