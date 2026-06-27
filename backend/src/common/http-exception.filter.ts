import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { MAX_FILE_SIZE_BYTES } from '../config/limits';

/**
 * Turns every failure into one consistent JSON shape the frontend can render.
 *
 * Error text is user-facing here: this is a demo a recruiter will poke at, so a
 * rejected upload should explain the limit that rejected it rather than
 * surfacing a raw framework message.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Something went wrong on the server.';
    let error = 'Internal Server Error';
    let extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        // class-validator returns message as an array of constraint failures.
        message = Array.isArray(record.message)
          ? (record.message as string[]).join(' ')
          : String(record.message ?? message);
        error = String(record.error ?? exception.name);
        if (record.quota) extra.quota = record.quota;
      }
    } else if (isMulterLimitError(exception)) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      error = 'File too large';
      message =
        `That file is larger than the ${(MAX_FILE_SIZE_BYTES / 1024 / 1024).toFixed(0)} MB limit. ` +
        `Anonymous runs are capped to keep this demo affordable — try a smaller document, or ` +
        `paste an excerpt as text.`;
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(`${request.method} ${request.url}: ${message}`, exception.stack);
    }

    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url} -> ${status}: ${message}`);
    }

    response.status(status).json({
      statusCode: status,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }
}

function isMulterLimitError(exception: unknown): boolean {
  return (
    typeof exception === 'object' &&
    exception !== null &&
    (exception as { code?: string }).code === 'LIMIT_FILE_SIZE'
  );
}
