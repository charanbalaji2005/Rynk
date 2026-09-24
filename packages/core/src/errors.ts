/**
 * Developer-friendly errors. Every RynkError carries a human explanation,
 * likely causes and suggested commands, while keeping the raw cause for
 * `--verbose` / `--json` consumers.
 */

export type ErrorCode =
  | "DETECTION_FAILED"
  | "DETECTION_AMBIGUOUS"
  | "CONFIG_INVALID"
  | "COMMAND_REJECTED"
  | "INSTALL_FAILED"
  | "BUILD_FAILED"
  | "START_FAILED"
  | "PROCESS_EXITED"
  | "PORT_UNAVAILABLE"
  | "HEALTH_CHECK_FAILED"
  | "LOCALHOST_ONLY"
  | "RUNTIME_UNAVAILABLE"
  | "DAEMON_UNREACHABLE"
  | "DAEMON_UNAUTHORIZED"
  | "NOT_FOUND"
  | "EXPOSURE_FAILED"
  | "INTERNAL";

export interface RynkErrorOptions {
  causes?: string[];
  suggestions?: string[];
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class RynkError extends Error {
  readonly code: ErrorCode;
  readonly causes: string[];
  readonly suggestions: string[];
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: RynkErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "RynkError";
    this.code = code;
    this.causes = opts.causes ?? [];
    this.suggestions = opts.suggestions ?? [];
    this.details = opts.details ?? {};
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      causes: this.causes,
      suggestions: this.suggestions,
      details: this.details,
      raw: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }

  static from(err: unknown): RynkError {
    if (err instanceof RynkError) return err;
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ECONNREFUSED") {
      return new RynkError("HEALTH_CHECK_FAILED", "Rynk could not reach your application.", {
        causes: [
          "The application failed to start.",
          "The selected port is already occupied.",
          "The server is listening only on localhost.",
          "A firewall is blocking LAN access.",
        ],
        suggestions: ["rynk logs", "rynk doctor"],
        cause: err,
      });
    }
    if (e?.code === "EADDRINUSE") {
      return new RynkError("PORT_UNAVAILABLE", "The requested port is already in use.", {
        suggestions: ["rynk start --port <other-port>", "rynk status"],
        cause: err,
      });
    }
    return new RynkError("INTERNAL", e?.message ?? String(err), { cause: err });
  }
}

export function isRynkError(e: unknown): e is RynkError {
  return e instanceof RynkError;
}
