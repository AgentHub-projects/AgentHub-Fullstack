import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module";
import { AllExceptionsFilter } from "./filters/all-exceptions.filter";
import { bootstrapDownstream } from "./modules/downstream.bootstrap";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new AllExceptionsFilter());

  // Wire the downstream JSON-RPC adapter once the DI container is ready.
  // bootstrapDownstream registers the transport-close hook that fans out
  // to DownstreamSessionManager.handleConnectionLost so dropped sockets
  // mark bound runs failed instead of leaving them in `running`.
  bootstrapDownstream(app);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
}

void bootstrap();
