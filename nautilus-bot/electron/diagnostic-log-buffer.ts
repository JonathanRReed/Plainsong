/**
 * A bounded, in-memory tail of what Plainsong logged this run.
 *
 * Nothing in a packaged build writes a log file: the sidecar logs to stderr
 * (rust-sidecar/src/bin/sidecar.rs) and the main process logs to the console,
 * and in an installed app both go to a stream nobody reads. So a tester who
 * hits a bug has nothing to attach, which is exactly the gap
 * `docs/beta/KNOWN-LIMITATIONS.md` describes.
 *
 * This keeps the last few hundred lines in memory so the support bundle has
 * something to redact and carry. It is deliberately *not* a log file:
 *
 * - it never touches disk on its own;
 * - it is dropped when the app quits;
 * - it is capped, so a chatty run cannot grow it without bound;
 * - it is never sent anywhere. The only reader is the support bundle, which
 *   the reader asks for by hand and saves where they choose.
 *
 * Redaction happens in the sidecar (rust-sidecar/src/support_bundle.rs), on
 * the way into the bundle, so there is one policy rather than two.
 */

/** Longest tail kept in memory. The bundle carries at most this many. */
export const DIAGNOSTIC_LOG_BUFFER_MAX_LINES = 400;

/** Longest single line kept. Anything longer is truncated on the way in. */
export const DIAGNOSTIC_LOG_LINE_MAX_CHARS = 2000;

export type DiagnosticLogSource = "sidecar" | "main" | "renderer";

/**
 * A fixed-size tail of log lines.
 *
 * Exported as a class so tests can drive one without touching the process-wide
 * instance below.
 */
export class DiagnosticLogBuffer {
  private readonly lines: string[] = [];

  constructor(private readonly maxLines: number = DIAGNOSTIC_LOG_BUFFER_MAX_LINES) {}

  /**
   * Record a chunk of output. A chunk may hold several lines (a stderr `data`
   * event usually does), so it is split, and blank lines are dropped.
   */
  record(source: DiagnosticLogSource, chunk: string): void {
    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        continue;
      }
      const truncated =
        line.length > DIAGNOSTIC_LOG_LINE_MAX_CHARS
          ? `${line.slice(0, DIAGNOSTIC_LOG_LINE_MAX_CHARS)}…[truncated]`
          : line;
      this.lines.push(`[${source}] ${truncated}`);
      if (this.lines.length > this.maxLines) {
        this.lines.splice(0, this.lines.length - this.maxLines);
      }
    }
  }

  /** The tail, oldest first. */
  snapshot(): string[] {
    return [...this.lines];
  }

  get size(): number {
    return this.lines.length;
  }

  clear(): void {
    this.lines.length = 0;
  }
}

/** The one buffer the running app fills. */
export const diagnosticLogBuffer = new DiagnosticLogBuffer();

/**
 * Mirror the main process's own console output into the buffer.
 *
 * Wraps rather than replaces: every call still reaches the original console,
 * so a developer watching a terminal sees exactly what they saw before. A
 * throwing formatter must not take the app down with it, so the mirror is
 * wrapped in its own try/catch.
 */
export function captureMainProcessConsole(
  target: Pick<Console, "log" | "warn" | "error"> = console,
  buffer: DiagnosticLogBuffer = diagnosticLogBuffer,
): void {
  for (const level of ["log", "warn", "error"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      original(...args);
      try {
        buffer.record("main", formatConsoleArguments(level, args));
      } catch {
        // A support-bundle nicety must never break logging.
      }
    };
  }
}

function formatConsoleArguments(level: string, args: unknown[]): string {
  const rendered = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  return `${level.toUpperCase()} ${rendered}`;
}
