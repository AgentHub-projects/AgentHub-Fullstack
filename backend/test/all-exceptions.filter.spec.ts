import { describe, expect, it, vi } from "vitest";
import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { AllExceptionsFilter } from "../src/filters/all-exceptions.filter";
import { ApiHttpException } from "../src/services/errors";

function makeHost(response: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }) {
  return {
    switchToHttp: () => ({
      getResponse: () => response
    })
  } as never;
}

describe("AllExceptionsFilter", () => {
  it("passes ApiErrorDto body through unchanged for ApiHttpException", () => {
    const filter = new AllExceptionsFilter();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = makeHost({ status, json });

    const exception = new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "not found",
      details: { resource: "run" }
    });
    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      code: "NOT_FOUND",
      message: "not found",
      details: { resource: "run" }
    });
  });

  it("normalises plain HttpException to ApiErrorDto shape", () => {
    const filter = new AllExceptionsFilter();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = makeHost({ status, json });

    const exception = new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "FORBIDDEN", message: "Forbidden" }));
  });

  it("does not leak NestJS statusCode or error fields as details", () => {
    const filter = new AllExceptionsFilter();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = makeHost({ status, json });

    filter.catch(new NotFoundException("missing"), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "NOT_FOUND", message: "missing" }));
    const body = json.mock.calls[0]?.[0] as { details?: Record<string, unknown> };
    expect(body.details?.statusCode).toBeUndefined();
    expect(body.details?.error).toBeUndefined();
  });

  it("normalises unexpected errors to 500 ApiErrorDto", () => {
    const filter = new AllExceptionsFilter();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = makeHost({ status, json });

    filter.catch(new Error("boom"), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ code: "INTERNAL_SERVER_ERROR", message: "boom" });
  });
});
