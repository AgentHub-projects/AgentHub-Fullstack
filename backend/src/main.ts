import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { AppModule } from "./modules/app.module";

/** 启动 NestJS 应用：启用 CORS、设置全局前缀 /api、监听 3001 端口 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: Number.POSITIVE_INFINITY }));
  app.use(urlencoded({ extended: true, limit: Number.POSITIVE_INFINITY }));
  app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix("api");

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, "127.0.0.1");
}

void bootstrap();
