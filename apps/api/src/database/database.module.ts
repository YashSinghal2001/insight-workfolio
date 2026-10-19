import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDatabase, migrate, type DatabaseClient } from "@workfolio/database";
import type { Env } from "../config/env.js";

export const DATABASE = Symbol("DATABASE");

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      // Migrations are additive and idempotent, so applying them at boot is safe.
      useFactory: async (config: ConfigService<Env, true>) => {
        const db = createDatabase({ url: config.get("DATABASE_URL"), authToken: config.get("DATABASE_AUTH_TOKEN") });
        const applied = await migrate(db);
        if (applied.length) new Logger("Database").log(`Applied migrations: ${applied.join(", ")}`);
        return db;
      },
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  onApplicationShutdown() {
    this.db.close();
  }
}
