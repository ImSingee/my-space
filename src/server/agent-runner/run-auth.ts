/**
 * Run authorization policy. Better Auth owns credential signing, verification
 * and stored signing keys; this module owns only Run binding and live leases.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '~/db';
import { getPlatformEnv } from '~env';
import { auth } from '~auth/server';
import { listConnectedRunners } from '~server/agent-runner/hub';

export class RunTokenError extends Error {
  constructor(
    public readonly code:
      | 'invalid_token'
      | 'run_ended'
      | 'runner_not_connected',
  ) {
    super(code);
    this.name = 'RunTokenError';
  }
}

export type RunTokenContext = {
  runId: string;
  sessionId: string;
  runnerId: string;
};

const claimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  rnr: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
});

async function requireLiveRun(context: RunTokenContext) {
  const run = await db.query.agentRuns.findFirst({
    where: { id: context.runId },
    columns: {
      sessionId: true,
      runnerId: true,
      status: true,
      leaseExpiresAt: true,
    },
  });
  if (
    !run ||
    run.sessionId !== context.sessionId ||
    run.runnerId !== context.runnerId ||
    !['running', 'blocked'].includes(run.status) ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= new Date()
  )
    throw new RunTokenError('run_ended');
}

/**
 * Mint a token for a live Run owned by `runnerId`. The internal fleet token
 * that authenticates this call proves membership in the trusted Runner fleet,
 * not a distinct Runner identity.
 */
export async function mintRunToken(runId: string, runnerId: string) {
  if (!listConnectedRunners().some((runner) => runner.runnerId === runnerId))
    throw new RunTokenError('runner_not_connected');
  const run = await db.query.agentRuns.findFirst({
    where: { id: runId },
    columns: { sessionId: true },
  });
  if (!run) throw new RunTokenError('run_ended');
  const context = { runId, sessionId: run.sessionId, runnerId };
  await requireLiveRun(context);
  const lifetimeSeconds = getPlatformEnv().runTokenLifetimeSeconds;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + lifetimeSeconds) * 1000);
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        sub: runId,
        sid: context.sessionId,
        rnr: runnerId,
        jti: randomUUID(),
        iat: issuedAt,
        exp: issuedAt + lifetimeSeconds,
      },
    },
  });
  return { token, expiresAt: expiresAt.toISOString(), context };
}

/** Verify signature, audience and expiry, then require the Run to be live. */
export async function verifyRunToken(
  token: string,
): Promise<RunTokenContext & { expiresAt: string }> {
  let claims: z.infer<typeof claimsSchema>;
  try {
    const { payload } = await auth.api.verifyJWT({ body: { token } });
    claims = claimsSchema.parse(payload);
  } catch {
    throw new RunTokenError('invalid_token');
  }
  const context = {
    runId: claims.sub,
    sessionId: claims.sid,
    runnerId: claims.rnr,
  };
  await requireLiveRun(context);
  return { ...context, expiresAt: new Date(claims.exp * 1000).toISOString() };
}
