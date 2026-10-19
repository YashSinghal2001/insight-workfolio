import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { ApiError } from "@workfolio/shared";
import type { Request, Response } from "express";

/** Normalizes every error into the shared ApiError envelope. Unknown errors never leak details. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();
    // originalUrl keeps the /api prefix; the query string is dropped so tokens never echo back.
    const path = req.originalUrl.split("?")[0] ?? req.originalUrl;

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = "Internal Server Error";
    let message: string | string[] = "An unexpected error occurred";

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
        error = exception.name;
      } else {
        const b = body as { message?: string | string[]; error?: string };
        message = b.message ?? exception.message;
        // Router 404s echo the raw URL ("Cannot GET /x?token=..."); strip the query string.
        if (typeof message === "string") message = message.replace(req.originalUrl, path);
        error = b.error ?? exception.name;
      }
    } else if (isExposedClientError(exception)) {
      // body-parser errors (malformed JSON, payload too large) are client errors, not 500s.
      statusCode = exception.status;
      error = exception.type ?? "Bad Request";
      message = exception.message;
    }

    if (statusCode >= 500) {
      this.logger.error({ err: exception, path }, "Unhandled error");
    }

    const payload: ApiError = {
      statusCode,
      error,
      message,
      path,
      timestamp: new Date().toISOString(),
      requestId: req.id,
    };
    res.status(statusCode).json(payload);
  }
}

/** http-errors style errors marked safe to show (e.g. from body-parser). */
function isExposedClientError(e: unknown): e is { status: number; message: string; type?: string } {
  const err = e as { expose?: unknown; status?: unknown } | null;
  return !!err && err.expose === true && typeof err.status === "number" && err.status >= 400 && err.status < 500;
}
