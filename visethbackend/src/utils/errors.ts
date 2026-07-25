export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badRequest(code: string, message: string, details?: Record<string, unknown>) {
  return new AppError(400, code, message, details);
}

export function unauthorized(message = 'Unauthenticated', code = 'UNAUTHENTICATED') {
  return new AppError(401, code, message);
}

export function forbidden(message = 'Forbidden', code = 'FORBIDDEN') {
  return new AppError(403, code, message);
}

export function notFound(message = 'Not found', code = 'NOT_FOUND') {
  return new AppError(404, code, message);
}

export function conflict(code: string, message: string, details?: Record<string, unknown>) {
  return new AppError(409, code, message, details);
}

export function unprocessable(code: string, message: string, details?: Record<string, unknown>) {
  return new AppError(422, code, message, details);
}

export function maintenance(message = 'Platform is in maintenance mode') {
  return new AppError(503, 'MAINTENANCE', message);
}

export function upstream(message: string, code = 'UPSTREAM_ERROR') {
  return new AppError(502, code, message);
}
