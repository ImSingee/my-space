export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
