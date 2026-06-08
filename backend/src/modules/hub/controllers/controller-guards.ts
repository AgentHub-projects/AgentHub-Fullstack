import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../services/prisma.service";

const ACTIVE_RUN_STATUSES = ["queued", "context_building", "connecting", "running"] as const;

/** 断言会话可写：活跃且无活跃 run */
export async function assertSessionWritable(prisma: PrismaService, sessionId: string) {
  await assertSessionActive(prisma, sessionId);
}

/** 断言会话存在且处于活跃状态 */
export async function assertSessionActive(prisma: PrismaService, sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });
  if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
  if (session.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");
}

export async function assertAgentSessionsWritable(prisma: PrismaService, agentId: number) {
  const links = await prisma.sessionAgent.findMany({
    where: { agentId },
    select: { sessionId: true },
  });
  for (const link of links) {
    await assertSessionWritable(prisma, link.sessionId);
  }
}

async function assertSessionHasNoActiveRun(prisma: PrismaService, sessionId: string) {
  const activeRun = await prisma.agentRun.findFirst({
    where: {
      sessionId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (activeRun) throw new BadRequestException("SESSION_HAS_ACTIVE_RUN");
}
