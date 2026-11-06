import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDatabase, type DatabaseClient } from "@workfolio/database";
import type { Env } from "../config/env.js";
import { prepareDatabase, prepareOptionsFor } from "./prepare.js";

export const DATABASE = Symbol("DATABASE");

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      // Local databases outside production are migrated at boot; hosted (Turso) ones and every production
      // database are only checked, and the API refuses to start if a migration is pending, unknown or
      // edited (see prepareDatabase).
      useFactory: async (config: ConfigService<Env, true>) => {
        const url = config.get("DATABASE_URL");
        const token = config.get("DATABASE_AUTH_TOKEN");
        const db = createDatabase({ url, authToken: token });
        const log = new Logger("Database");
        try {
          await prepareDatabase(db, prepareOptionsFor(url, config.get("NODE_ENV")), (line) => log.log(line));
        } catch (err) {
          db.close();
          // Messages name migrations, never values; strip the token anyway in case a driver echoes it.
          const message = String((err as Error).message ?? err);
          throw new Error(token ? message.split(token).join("[redacted]") : message);
        }
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
