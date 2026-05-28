import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { ApiErrorDto } from "@agenthub/shared";
import { ApiHttpException } from "../services/errors";

interface HttpResponse {
  status(code: number): this;
  json(body: unknown): this;
}

/**
 * Catches all exceptions and normalises them to the ApiErrorDto shape:
 * { code, message, details? }
 *
 * NestJS HttpExceptions thrown via ApiHttpException already carry an ApiErrorDto
 * body; this filter just ensures every unhandled error also gets the same shape.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<HttpResponse>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (exception instanceof ApiHttpException && isApiErrorDto(body)) {
        response.status(status).json(body);
        return;
      }

      const details = getSafeHttpExceptionDetails(body);
      const error: ApiErrorDto = {
        code: httpStatusToCode(status),
        message: getHttpExceptionMessage(body, exception.message),
        ...(details === undefined ? {} : { details })
      };
      response.status(status).json(error);
      return;
    }

    // Unexpected / unhandled errors
    const message = exception instanceof Error ? exception.message : String(exception);
    const error: ApiErrorDto = {
      code: "INTERNAL_SERVER_ERROR",
      message
    };
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(error);
  }
}

function isApiErrorDto(body: unknown): body is ApiErrorDto {
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    typeof body.code === "string" &&
    "message" in body &&
    typeof body.message === "string"
  );
}

function getHttpExceptionMessage(body: unknown, fallback: string): string {
  if (typeof body === "string") {
    return body;
  }
  if (isRecord(body)) {
    const message = body.message;
    if (Array.isArray(message)) {
      return message.join(", ");
    }
    if (typeof message === "string") {
      return message;
    }
  }
  return fallback;
}

function getSafeHttpExceptionDetails(body: unknown): unknown {
  if (isRecord(body) && Array.isArray(body.validationErrors)) {
    return { validationErrors: body.validationErrors };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function httpStatusToCode(status: number): string {
  const map: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "UNPROCESSABLE_ENTITY",
    429: "TOO_MANY_REQUESTS",
    500: "INTERNAL_SERVER_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE"
  };
  return map[status] ?? `HTTP_${status}`;
}
