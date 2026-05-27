import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Single Prisma client owned by the Nest DI container. Connecting on
 * `onModuleInit` and disconnecting on `onModuleDestroy` keeps the lifetime
 * tied to the application lifecycle so providers that depend on Prisma
 * (downstream persistence, etc.) get a live client without each provider
 * managing its own connection.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (err) {
      // Surface but don't crash the boot — local dev runs without
      // DATABASE_URL still need to come up so non-DB endpoints work and
      // the team can run tests offline.
      this.log.warn(
        `PrismaService failed to connect on startup: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
