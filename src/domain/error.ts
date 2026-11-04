export const ERROR_CODES = [
  "BAD_INPUT",
  "ALREADY_IN_QUEUE",
  "QR_EXPIRED",
  "NOT_LOGGED_IN",
  "DISPLAY_LINK_INVALID",
  "STATE_CHANGED",
  "QR_INVALID",
  "NOT_FOUND",
  "BAD_PIN",
  "TABLE_IN_USE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(message: string, code: ErrorCode) {
    super(message);
    this.code = code;
    this.name = "AppError";
  }
}
