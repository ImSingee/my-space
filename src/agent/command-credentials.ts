/** Transient credentials available only to an authorized command process. */
export type CommandCredentialEnvironment = {
  signal: AbortSignal;
  env: Record<string, string>;
  redact: (value: string) => string;
  /** Streaming redaction must retain partial secrets between chunks. */
  stream: (emit: (value: string) => void) => {
    write: (value: string) => void;
    flush: () => void;
  };
};

export type CommandCredentials = {
  withEnvironment<T>(
    signal: AbortSignal | undefined,
    execute: (credentials: CommandCredentialEnvironment) => Promise<T>,
  ): Promise<T>;
};
