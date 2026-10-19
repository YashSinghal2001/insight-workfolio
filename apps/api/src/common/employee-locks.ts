import { Injectable } from "@nestjs/common";

/**
 * Serializes attendance writes (clock events, corrections) per employee within this process.
 * ponytail: per-process only; with several API instances the schema triggers and partial unique
 * indexes still reject races (as 409), they just stop being rare. Move to a DB/Redis lock then.
 */
@Injectable()
export class EmployeeLocks {
  private readonly locks = new Map<string, Promise<unknown>>();

  run<T>(employeeId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(employeeId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(employeeId, tail);
    void tail.then(() => this.locks.get(employeeId) === tail && this.locks.delete(employeeId));
    return run;
  }
}
