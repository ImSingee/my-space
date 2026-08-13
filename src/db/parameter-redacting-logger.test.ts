import { describe, expect, it } from 'vitest';

import { ParameterRedactingLogger } from './parameter-redacting-logger';

describe('ParameterRedactingLogger', () => {
  it('logs the query template without bound plaintext or ciphertext', () => {
    const messages: string[] = [];
    const logger = new ParameterRedactingLogger({
      write(message) {
        messages.push(message);
      },
    });

    logger.logQuery('insert into app_kv values ($1, $2)', [
      'plaintext-secret',
      'v1.encrypted-envelope',
    ]);

    expect(messages).toEqual(['Query: insert into app_kv values ($1, $2)']);
    expect(messages.join('\n')).not.toContain('plaintext-secret');
    expect(messages.join('\n')).not.toContain('v1.encrypted-envelope');
  });
});
