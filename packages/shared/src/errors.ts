import type { APIErrorType } from './types.js';

export class AppError extends Error {
  public readonly type: APIErrorType;
  public readonly code: string;
  public readonly statusCode: number;
  public readonly param?: string;
  public readonly retryAfter?: number;

  constructor(opts: {
    type: APIErrorType;
    message: string;
    code: string;
    statusCode: number;
    param?: string;
    retryAfter?: number;
  }) {
    super(opts.message);
    this.name = 'AppError';
    this.type = opts.type;
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.param = opts.param;
    this.retryAfter = opts.retryAfter;
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        message: this.message,
        code: this.code,
        ...(this.param ? { param: this.param } : {}),
        ...(this.retryAfter ? { retry_after: this.retryAfter } : {}),
      },
    };
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Invalid or missing API key') {
    super({
      type: 'authentication_error',
      message,
      code: 'invalid_api_key',
      statusCode: 401,
    });
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfter: number) {
    super({
      type: 'rate_limit_error',
      message: 'Rate limit exceeded. Please retry after the specified time.',
      code: 'rate_limit_exceeded',
      statusCode: 429,
      retryAfter,
    });
  }
}

export class InvalidRequestError extends AppError {
  constructor(message: string, param?: string) {
    super({
      type: 'invalid_request',
      message,
      code: 'invalid_request_error',
      statusCode: 400,
      param,
    });
  }
}

export class ModelError extends AppError {
  constructor(message: string, code = 'model_error') {
    super({
      type: 'model_error',
      message,
      code,
      statusCode: 502,
    });
  }
}

export class SandboxError extends AppError {
  constructor(message: string, code = 'sandbox_error') {
    super({
      type: 'sandbox_error',
      message,
      code,
      statusCode: 500,
    });
  }
}

export class WorkflowError extends AppError {
  constructor(message: string, code = 'workflow_error') {
    const notFound = code === 'workflow_not_found';
    super({
      type: 'workflow_error',
      message,
      code,
      statusCode: notFound ? 404 : 500,
    });
  }
}

export class BillingError extends AppError {
  constructor(message: string, code = 'insufficient_credits') {
    super({
      type: 'billing_error',
      message,
      code,
      statusCode: 402,
    });
  }
}

export class InternalError extends AppError {
  constructor(message = 'An internal error occurred') {
    super({
      type: 'internal_error',
      message,
      code: 'internal_error',
      statusCode: 500,
    });
  }
}

export const getErrorMessage = (error: unknown, fallback = 'Unknown error'): string => {
  if (error instanceof AppError) {
    return error.message || fallback;
  }

  if (error instanceof Error) {
    return error.message || fallback;
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed || fallback;
  }

  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
      return maybeMessage.trim();
    }

    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }

  return fallback;
};
