/**
 * Run authorization policy. Better Auth owns credential signing, verification
 * and stored signing keys; this module owns only Run binding and live leases.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const LIFETIME_SECONDS = 300;

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
  const { db } = await import('~/db');
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
  const { listConnectedRunners } = await import('~server/agent-runner/hub');
  if (!listConnectedRunners().some((runner) => runner.runnerId === runnerId))
    throw new RunTokenError('runner_not_connected');
  const { db } = await import('~/db');
  const run = await db.query.agentRuns.findFirst({
    where: { id: runId },
    columns: { sessionId: true },
  });
  if (!run) throw new RunTokenError('run_ended');
  const context = { runId, sessionId: run.sessionId, runnerId };
  await requireLiveRun(context);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + LIFETIME_SECONDS) * 1000);
  const { auth } = await import('~auth/server');
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        sub: runId,
        sid: context.sessionId,
        rnr: runnerId,
        jti: randomUUID(),
        iat: issuedAt,
        exp: issuedAt + LIFETIME_SECONDS,
      },
    },
  });
  return { token, expiresAt: expiresAt.toISOString(), context };
}

/** Verify signature, audience and expiry, then require the Run to be live. */
export async function verifyRunToken(token: string): Promise<RunTokenContext> {
  let claims: z.infer<typeof claimsSchema>;
  try {
    const { auth } = await import('~auth/server');
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
  return context;
}
