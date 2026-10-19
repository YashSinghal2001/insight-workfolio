import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";

/** Validates with a shared zod schema. Messages name fields and rules, never echo values. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
    }
    return result.data;
  }
}
