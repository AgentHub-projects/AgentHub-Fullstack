import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const IDS = {
  tplOrchestrator: "00000000-0000-4000-8000-000000000001",
  tplFrontend: "00000000-0000-4000-8000-000000000002",
  tplBackend: "00000000-0000-4000-8000-000000000003",
  tplReviewer: "00000000-0000-4000-8000-000000000004",
  orchestrator: 1,
  frontend: 2,
  backend: 3,
  reviewer: 4,
};

async function main() {
  // Seed providers table first
  const claudeProvider = await prisma.provider.upsert({
    where: { name: "claude-code" },
    create: { name: "claude-code" },
    update: {},
  });
  const openProvider = await prisma.provider.upsert({
    where: { name: "open-code" },
    create: { name: "open-code" },
    update: {},
  });

  await prisma.agentTemplate.upsert({
    where: { id: IDS.tplOrchestrator },
    create: {
      id: IDS.tplOrchestrator,
      name: "主 Orchestrator 模板",
      description: "负责理解用户目标、协调被 @ 的 Agent，并按群聊方式回传产出。",
      defaultProviderId: claudeProvider.id,
      systemPrompt: "你是 AgentHub 的主协调 Agent。你负责把任务交给下游协作系统，并持续上报 speaker、artifact 与文件变更事件。",
      defaultCapabilities: ["orchestrate", "stream", "file_change", "artifact"],
      defaultModelConfig: { provider: "openai-compatible" },
      status: "enabled",
    },
    update: { status: "enabled" },
  });

  await prisma.agentTemplate.upsert({
    where: { id: IDS.tplFrontend },
    create: {
      id: IDS.tplFrontend,
      name: "Frontend Agent 模板",
      description: "负责前端 UI、状态管理、实时渲染和用户体验。",
      defaultProviderId: claudeProvider.id,
      systemPrompt: "你负责前端实现，输出事件需要携带 speaker=frontend agentId。",
      defaultCapabilities: ["frontend", "react", "diff", "artifact"],
      defaultModelConfig: { provider: "openai-compatible" },
      status: "enabled",
    },
    update: { status: "enabled" },
  });

  await prisma.agentTemplate.upsert({
    where: { id: IDS.tplBackend },
    create: {
      id: IDS.tplBackend,
      name: "Backend Agent 模板",
      description: "负责后端 API、数据库、WebSocket、OSS 与上下文维护。",
      defaultProviderId: openProvider.id,
      systemPrompt: "你负责后端实现，输出事件需要携带 speaker=backend agentId。",
      defaultCapabilities: ["backend", "postgresql", "websocket", "oss"],
      defaultModelConfig: { provider: "openai-compatible" },
      status: "enabled",
    },
    update: { status: "enabled" },
  });

  await prisma.agentTemplate.upsert({
    where: { id: IDS.tplReviewer },
    create: {
      id: IDS.tplReviewer,
      name: "Review Agent 模板",
      description: "负责验收、回归风险、文档一致性和质量反馈。",
      defaultProviderId: openProvider.id,
      systemPrompt: "你负责审查实现是否满足 AgentHub 设计文档。",
      defaultCapabilities: ["review", "test", "acceptance"],
      defaultModelConfig: { provider: "openai-compatible" },
      status: "enabled",
    },
    update: { status: "enabled" },
  });

  await prisma.agent.upsert({
    where: { id: IDS.orchestrator },
    create: {
      id: IDS.orchestrator,
      templateId: IDS.tplOrchestrator,
      name: "main-orchestrator",
      description: "用户消息进入下游 Orchestrator 的默认会话级入口。",
      providerId: claudeProvider.id,
      isDefaultOrchestrator: true,
      status: "offline",
    },
    update: {
      isDefaultOrchestrator: true,
    },
  });

  await prisma.agent.upsert({
    where: { id: IDS.frontend },
    create: {
      id: IDS.frontend,
      templateId: IDS.tplFrontend,
      name: "frontend-agent",
      description: "群聊成员：前端实现。",
      providerId: claudeProvider.id,
      status: "enabled",
    },
    update: { status: "enabled" },
  });

  await prisma.agent.upsert({
    where: { id: IDS.backend },
    create: {
      id: IDS.backend,
      templateId: IDS.tplBackend,
      name: "backend-agent",
      description: "群聊成员：后端实现。",
      providerId: openProvider.id,
      status: "enabled",
    },
    update: { status: "enabled" },
  });

  await prisma.agent.upsert({
    where: { id: IDS.reviewer },
    create: {
      id: IDS.reviewer,
      templateId: IDS.tplReviewer,
      name: "review-agent",
      description: "群聊成员：验收与审查。",
      providerId: openProvider.id,
      status: "enabled",
    },
    update: { status: "enabled" },
  });

  console.log("Seed complete: AgentTemplate and Agent defaults are ready.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
