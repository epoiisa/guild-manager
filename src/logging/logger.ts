import type { LogLevel } from "../config.js";

type LogContext = Record<string, unknown>;

const MAX_LOG_STRING_LENGTH = 2_000;
const MAX_LOG_DEPTH = 6;
const SENSITIVE_KEY_PATTERN = /authorization|cookie|password|secret|token|database.?url|connection.?string/i;
const PRIVATE_DISPLAY_KEY_PATTERN = /^(botUsername|channelName|characterName|characters|guildName|nextName|previousName)$/i;
const URI_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s@/]+)@/gi;

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export function logErrorContext(error: unknown, includeStack = false): LogContext {
  if (!(error instanceof Error)) {
    return { error: String(error) };
  }

  const context: LogContext = {
    error: error.message,
    errorType: error.name
  };
  const record = error as Error & { code?: unknown; status?: unknown };
  if (typeof record.code === "string" || typeof record.code === "number") {
    context.errorCode = record.code;
  }
  if (typeof record.status === "string" || typeof record.status === "number") {
    context.errorStatus = record.status;
  }
  if (includeStack && error.stack) {
    context.errorStack = error.stack;
  }
  return context;
}

export function createLogger(minimumLevel: LogLevel, baseContext: LogContext = {}): Logger {
  function write(level: LogLevel, message: string, context: LogContext = {}): void {
    if (levelWeights[level] < levelWeights[minimumLevel]) return;

    const safeContext = sanitizeLogContext({ ...baseContext, ...context });
    const entry = {
      ...safeContext,
      timestamp: new Date().toISOString(),
      level,
      message: sanitizeLogString(message)
    };

    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context)
  };
}

function sanitizeLogContext(context: LogContext): LogContext {
  const seen = new WeakSet<object>();
  return Object.fromEntries(
    Object.entries(context)
      .filter(([key]) => !PRIVATE_DISPLAY_KEY_PATTERN.test(key))
      .map(([key, value]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key)
          ? "[REDACTED]"
          : sanitizeLogValue(value, seen, 0)
      ])
  );
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return sanitizeLogString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_LOG_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";

  seen.add(value);
  if (value instanceof Error) {
    return sanitizeLogValue(logErrorContext(value), seen, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_DISPLAY_KEY_PATTERN.test(key))
      .map(([key, item]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key)
          ? "[REDACTED]"
          : sanitizeLogValue(item, seen, depth + 1)
      ])
  );
}

function sanitizeLogString(value: string): string {
  const redacted = value.replace(URI_CREDENTIALS_PATTERN, "$1[REDACTED]@");
  if (redacted.length <= MAX_LOG_STRING_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_LOG_STRING_LENGTH)}...[TRUNCATED]`;
}
