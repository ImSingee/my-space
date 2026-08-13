import {
  ConsoleLogWriter,
  type Logger,
  type LogWriter,
} from 'drizzle-orm/logger';

/**
 * Development query logger that deliberately omits bound parameters.
 *
 * Drizzle's default logger includes every parameter in its output. Some of
 * those parameters are encrypted credentials or KV secret envelopes, so even
 * ciphertext must not be copied into application logs.
 */
export class ParameterRedactingLogger implements Logger {
  constructor(private readonly writer: LogWriter = new ConsoleLogWriter()) {}

  logQuery(query: string, _params: unknown[]): void {
    this.writer.write(`Query: ${query}`);
  }
}

export const developmentQueryLogger = new ParameterRedactingLogger();
