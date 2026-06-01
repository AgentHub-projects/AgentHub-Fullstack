import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

const AGENT_IDS = {
  orchestrator: 1,
  frontend: 2,
  backend: 3,
  reviewer: 4,
};

async function main() {
  const adminPassword = process.env.AGENTHUB_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("AGENTHUB_ADMIN_PASSWORD is required to seed the admin user.");
  }

  await prisma.user.upsert({
    where: { username: "admin" },
    create: {
      username: "admin",
      passwordHash: hashSeedPassword(adminPassword),
      status: "active",
    },
    update: { status: "active" },
  });

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

  const tplOrchestrator = await ensureTemplate("主 Orchestrator 模板", {
    description: "负责理解用户目标、协调被 @ 的 Agent，并按群聊方式回传产出。",
    defaultProviderId: claudeProvider.id,
    systemPrompt: "你是 AgentHub 的主协调 Agent。你负责把任务交给下游协作系统，并持续上报 speaker、artifact 与文件变更事件。",
    defaultCapabilities: ["orchestrate", "stream", "file_change", "artifact"],
    defaultModelConfig: { provider: "openai-compatible" },
    status: "enabled",
  });

  const tplFrontend = await ensureTemplate("Frontend Agent 模板", {
    description: "负责前端 UI、状态管理、实时渲染和用户体验。",
    defaultProviderId: claudeProvider.id,
    systemPrompt: "你负责前端实现，输出事件需要携带 speaker=frontend agentId。",
    defaultCapabilities: ["frontend", "react", "diff", "artifact"],
    defaultModelConfig: { provider: "openai-compatible" },
    status: "enabled",
  });

  const tplBackend = await ensureTemplate("Backend Agent 模板", {
    description: "负责后端 API、数据库、WebSocket、OSS 与上下文维护。",
    defaultProviderId: openProvider.id,
    systemPrompt: "你负责后端实现，输出事件需要携带 speaker=backend agentId。",
    defaultCapabilities: ["backend", "postgresql", "websocket", "oss"],
    defaultModelConfig: { provider: "openai-compatible" },
    status: "enabled",
  });

  const tplReviewer = await ensureTemplate("Review Agent 模板", {
    description: "负责验收、回归风险、文档一致性和质量反馈。",
    defaultProviderId: openProvider.id,
    systemPrompt: "你负责审查实现是否满足 AgentHub 设计文档。",
    defaultCapabilities: ["review", "test", "acceptance"],
    defaultModelConfig: { provider: "openai-compatible" },
    status: "enabled",
  });

  await prisma.agent.upsert({
    where: { id: AGENT_IDS.orchestrator },
    create: {
      id: AGENT_IDS.orchestrator,
      templateId: tplOrchestrator.id,
      name: "main-orchestrator",
      description: "用户消息进入下游 Orchestrator 的默认会话级入口。",
      providerId: claudeProvider.id,
      isDefaultOrchestrator: true,
      status: "offline",
    },
    update: {
      templateId: tplOrchestrator.id,
      providerId: claudeProvider.id,
      isDefaultOrchestrator: true,
    },
  });

  await prisma.agent.upsert({
    where: { id: AGENT_IDS.frontend },
    create: {
      id: AGENT_IDS.frontend,
      templateId: tplFrontend.id,
      name: "frontend-agent",
      description: "群聊成员：前端实现。",
      providerId: claudeProvider.id,
      status: "enabled",
    },
    update: { templateId: tplFrontend.id, providerId: claudeProvider.id, status: "enabled" },
  });

  await prisma.agent.upsert({
    where: { id: AGENT_IDS.backend },
    create: {
      id: AGENT_IDS.backend,
      templateId: tplBackend.id,
      name: "backend-agent",
      description: "群聊成员：后端实现。",
      providerId: openProvider.id,
      status: "enabled",
    },
    update: { templateId: tplBackend.id, providerId: openProvider.id, status: "enabled" },
  });

  await prisma.agent.upsert({
    where: { id: AGENT_IDS.reviewer },
    create: {
      id: AGENT_IDS.reviewer,
      templateId: tplReviewer.id,
      name: "review-agent",
      description: "群聊成员：验收与审查。",
      providerId: openProvider.id,
      status: "enabled",
    },
    update: { templateId: tplReviewer.id, providerId: openProvider.id, status: "enabled" },
  });

  await syncSerialSequences();
  console.log("Seed complete: admin user, AgentTemplate and Agent defaults are ready.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

async function ensureTemplate(name: string, data: Record<string, unknown>) {
  const existing = await prisma.agentTemplate.findFirst({ where: { name } });
  if (existing) {
    return prisma.agentTemplate.update({
      where: { id: existing.id },
      data: data as any,
    });
  }
  return prisma.agentTemplate.create({ data: { name, ...data } as any });
}

async function syncSerialSequences() {
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      '"agent_templates_id_seq"',
      GREATEST((SELECT COALESCE(MAX(id), 1) FROM "agent_templates"), 1),
      true
    )
  `);
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      '"agents_id_seq"',
      GREATEST((SELECT COALESCE(MAX(id), 1) FROM "agents"), 1),
      true
    )
  `);
}

function hashSeedPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
