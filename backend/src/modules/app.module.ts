import { Module } from "@nestjs/common";
import { HubModule } from "./hub/hub.module";

/** 应用根模块，导入 HubModule */
@Module({
  imports: [HubModule],
})
export class AppModule {}
