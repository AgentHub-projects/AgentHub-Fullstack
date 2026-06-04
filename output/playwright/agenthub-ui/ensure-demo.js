async function ensureDemo(page) {
  async function api(route, options = {}) {
    return page.evaluate(async ({ route, options }) => {
      const response = await fetch(`http://localhost:3001/api${route}`, {
        credentials: "include",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${route}: ${response.status} ${text}`);
      return text ? JSON.parse(text) : null;
    }, { route, options });
  }

  const demoTitle = "截图验收：Mock 产物与上下文 2";
  let sessions = await api("/sessions");
  let session = sessions.items.find((item) => item.title === demoTitle) ?? null;

  if (!session) {
    const templates = await api("/agent-templates");
    const orchestrator = templates.find((item) => item.name.includes("Orchestrator")) ?? templates[0];
    const members = templates.filter((item) => item.id !== orchestrator.id).slice(0, 3);
    if (!orchestrator) throw new Error("没有可用的 Orchestrator 模板");
    session = await api("/sessions", {
      method: "POST",
      body: JSON.stringify({
        mode: "group",
        title: demoTitle,
        orchestratorTemplateId: orchestrator.id,
        orchestratorProvider: orchestrator.defaultProvider,
        orchestratorName: "main-orchestrator",
        memberTemplates: members.map((item) => ({
          templateId: item.id,
          provider: item.defaultProvider,
          name: item.name.replace(" 模板", ""),
        })),
      }),
    });
  }

  let detail = await api(`/sessions/${encodeURIComponent(session.id)}`);
  const hasDemoSurface = detail.messages.length > 0 && detail.fileChanges.length > 0 && detail.artifacts.length > 0 && detail.context;
  if (!hasDemoSurface) {
    const mentionedAgentIds = Array.isArray(detail.session.metadata.memberAgentIds)
      ? detail.session.metadata.memberAgentIds.filter((item) => typeof item === "number")
      : [];
    await api(`/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: "@frontend-agent @backend-agent @review-agent 请协作生成一个 AgentHub 课题展示卡片，包含 React 代码、HTML 预览、Diff 和验收摘要。",
        mentionedAgentIds,
      }),
    });

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      detail = await api(`/sessions/${encodeURIComponent(session.id)}`);
      if (detail.fileChanges.length > 0 && detail.artifacts.length > 0 && detail.context) break;
      const latestRun = detail.runs.at(-1);
      if (latestRun?.status === "failed" || latestRun?.status === "cancelled") break;
    }
  }

  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".agenthubShell", { timeout: 30000 });
  await page.waitForTimeout(2500);
}
