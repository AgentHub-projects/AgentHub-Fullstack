import { HttpException, HttpStatus } from "@nestjs/common";
import type { ApiErrorDto } from "@agenthub/shared";

export class ApiHttpException extends HttpException {
  constructor(status: HttpStatus, error: ApiErrorDto) {
    super(error, status);
  }
}
