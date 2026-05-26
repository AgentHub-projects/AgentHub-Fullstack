import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    await this.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await this.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS vector");
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
