import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import { parseHolidayCsv, type Holiday, type HolidayImportResult, type HolidayInput } from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { DATABASE } from "../database/database.module.js";

const SELECT = "SELECT h.id, h.date, h.name, h.created_at, u.id AS user_id, u.email FROM holidays h JOIN users u ON u.id = h.created_by";
const toHoliday = (r: Row): Holiday => ({
  id: String(r.id),
  date: String(r.date),
  name: String(r.name),
  createdBy: { id: String(r.user_id), email: String(r.email) },
  createdAt: String(r.created_at),
});

/** Organisation-wide holiday calendar (W38) and CSV import (W39). Admin only. */
@Injectable()
export class HolidaysService {
  private readonly logger = new Logger(HolidaysService.name);

  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  async list(year?: number): Promise<Holiday[]> {
    const { rows } = await this.db.execute({ sql: `${SELECT} WHERE ?1 IS NULL OR substr(h.date, 1, 4) = ?1 ORDER BY h.date`, args: [year ? String(year) : null] });
    return rows.map(toHoliday);
  }

  async create(admin: AuthContext, input: HolidayInput): Promise<Holiday> {
    const id = randomUUID();
    try {
      await this.db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, ?, ?, ?)", args: [id, input.date, input.name, admin.id] });
    } catch (err) {
      if (isUniqueViolation(err, "holidays.date")) throw new ConflictException(`${input.date} is already a holiday`);
      throw err;
    }
    this.logger.log({ holidayId: id, actorId: admin.id }, "Holiday added");
    return toHoliday((await this.db.execute({ sql: `${SELECT} WHERE h.id = ?`, args: [id] })).rows[0]!);
  }

  async remove(admin: AuthContext, id: string): Promise<void> {
    const { rowsAffected } = await this.db.execute({ sql: "DELETE FROM holidays WHERE id = ?", args: [id] });
    if (!rowsAffected) throw new NotFoundException("Holiday not found");
    this.logger.log({ holidayId: id, actorId: admin.id }, "Holiday removed");
  }

  /** All rows or none: any bad line is a 400 listing the lines. Dates that already have a holiday are skipped. */
  async import(admin: AuthContext, csv: string): Promise<HolidayImportResult> {
    const { rows, errors } = parseHolidayCsv(csv);
    if (errors.length) throw new BadRequestException(errors.slice(0, 20).join("; "));
    const results = await this.db.batch(
      rows.map((h) => ({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, ?, ?, ?) ON CONFLICT (date) DO NOTHING", args: [randomUUID(), h.date, h.name, admin.id] })),
      "write",
    );
    const skipped = rows.filter((_, i) => !results[i]!.rowsAffected).map((h) => h.date);
    this.logger.log({ actorId: admin.id, created: rows.length - skipped.length, skipped: skipped.length }, "Holidays imported");
    return { created: rows.length - skipped.length, skipped };
  }
}
