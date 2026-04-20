export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  constructor(private readonly component: string) {}

  debug(message: string, data: Record<string, unknown> = {}) {
    this.write("debug", message, data);
  }

  info(message: string, data: Record<string, unknown> = {}) {
    this.write("info", message, data);
  }

  warn(message: string, data: Record<string, unknown> = {}) {
    this.write("warn", message, data);
  }

  error(message: string, data: Record<string, unknown> = {}) {
    this.write("error", message, data);
  }

  private write(level: LogLevel, message: string, data: Record<string, unknown>) {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        component: this.component,
        message,
        ...data
      }) + "\n"
    );
  }
}
