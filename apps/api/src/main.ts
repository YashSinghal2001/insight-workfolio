import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import type { Env } from "./config/env.js";

const app = await NestFactory.create(AppModule, { bufferLogs: true });
configureApp(app);
const config = app.get<ConfigService<Env, true>>(ConfigService);
// Loopback by default (HOST): only the reverse proxy on this host reaches the API directly.
await app.listen(config.get("PORT"), config.get("HOST"));
