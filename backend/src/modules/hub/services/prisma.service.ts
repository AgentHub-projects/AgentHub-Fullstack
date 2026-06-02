import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/** Prisma 数据库服务：管理连接生命周期，自动创建 pgcrypto 和 vector 扩展 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /** 模块初始化时连接数据库并创建必要的 PostgreSQL 扩展 */
  async onModuleInit() {
    await this.$connect();
    await this.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await this.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS vector");
  }

  /** 模块销毁时断开数据库连接 */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
