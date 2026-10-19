import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import type { Env } from "./config/env.js";

const app = await NestFactory.create(AppModule, { bufferLogs: true });
configureApp(app);
await app.listen(app.get<ConfigService<Env, true>>(ConfigService).get("PORT"));
