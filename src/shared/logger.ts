type LogFields = Record<string, string | number | boolean | undefined>;

export function createLogger(scope: string) {
  const write = (method: "debug" | "warn" | "error", message: string, fields?: LogFields) => {
    const safeFields = fields ? JSON.stringify(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, isSensitiveKey(key) ? "[redacted]" : value]))) : "";
    console[method](`[Kimi Copilot:${scope}] ${message}${safeFields ? ` ${safeFields}` : ""}`);
  };

  return {
    debug: (message: string, fields?: LogFields) => write("debug", message, fields),
    warn: (message: string, fields?: LogFields) => write("warn", message, fields),
    error: (message: string, fields?: LogFields) => write("error", message, fields),
  };
}

function isSensitiveKey(key: string): boolean {
  return /token|authorization|cookie|secret|prompt|content|body|response|text/i.test(key);
}
