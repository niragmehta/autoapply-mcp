/**
 * Structured error type. Every tool failure carries a stable `code` so agents
 * can branch on it instead of parsing prose.
 */
export class AppError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function toErrorMessage(error: unknown): string {
  if (isAppError(error)) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
