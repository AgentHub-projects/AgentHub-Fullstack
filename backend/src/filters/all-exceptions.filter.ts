import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { ApiErrorDto } from "@agenthub/shared";

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

      // ApiHttpException already sets body to ApiErrorDto
      if (typeof body === "object" && body !== null && "code" in body && "message" in body) {
        response.status(status).json(body);
        return;
      }

      // Plain NestJS HttpException (e.g. NotFoundException from guards)
      const message = typeof body === "string" ? body : (body as { message?: string }).message ?? exception.message;
      const error: ApiErrorDto = {
        code: httpStatusToCode(status),
        message,
        details: typeof body === "object" ? body : undefined
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
