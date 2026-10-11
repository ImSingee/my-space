import { AppError } from '~server/errors';

/** A stable machine-readable CLI API error, returned as `{ "error": code }`. */
export class CliError extends AppError {
  constructor(
    readonly code: string,
    status: number,
  ) {
    super(code, status);
    this.name = 'CliError';
  }
}
