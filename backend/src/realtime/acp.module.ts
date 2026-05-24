import { Module } from "@nestjs/common";
import { AcpController, AcpService } from "./acp-server";
import { AgentEventsGateway } from "./agent-events.gateway";

@Module({
  controllers: [AcpController],
  providers: [AcpService, AgentEventsGateway],
  exports: [AcpService],
})
export class AcpModule {}
