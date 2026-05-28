import { Module } from "@nestjs/common";
import { HubModule } from "./hub/hub.module";

@Module({
  imports: [HubModule],
})
export class AppModule {}
