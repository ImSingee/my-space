/**
 * Short-lived Run tokens: stateless JWTs that let a live Agent Run call the CLI
 * API. Nothing is stored per token. Every use rechecks the Run itself, so
 * cancelling or finishing the Run ends its tokens immediately; renewal is just
 * minting another token while the Run is live.
 */
import { hkdfSync, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { db } from '~/db';
import { getPlatformEnv } from '~env';
import { CliError } from './error';

const AUDIENCE = 'hatch-run';
const LIFETIME_SECONDS = 300;

export type RunTokenContext = {
  runId: string;
  sessionId: string;
  runnerId: string;
};

const claimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  rnr: z.string().min(1),
});

let cachedKey: Uint8Array | undefined;
/** A key dedicated to Run tokens, derived from the platform auth secret. */
function signingKey(): Uint8Array {
  cachedKey ??= new Uint8Array(
    hkdfSync(
      'sha256',
      getPlatformEnv().betterAuthSecret,
      '',
      'hatch run token v1',
      32,
    ),
  );
  return cachedKey;
}

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
    throw new CliError('run_ended', 401);
}

/**
 * Mint a token for a live Run owned by `runnerId`. The internal fleet token
 * that authenticates this call proves membership in the trusted Runner fleet,
 * not a distinct Runner identity.
 */
export async function mintRunToken(runId: string, runnerId: string) {
  const { listConnectedRunners } = await import('~server/agent-runner/hub');
  if (!listConnectedRunners().some((runner) => runner.runnerId === runnerId))
    throw new CliError('runner_not_connected', 403);
  const run = await db.query.agentRuns.findFirst({
    where: { id: runId },
    columns: { sessionId: true },
  });
  if (!run) throw new CliError('run_ended', 401);
  const context = { runId, sessionId: run.sessionId, runnerId };
  await requireLiveRun(context);
  const expiresAt = new Date(Date.now() + LIFETIME_SECONDS * 1000);
  const token = await new SignJWT({ sid: context.sessionId, rnr: runnerId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(getPlatformEnv().appUrl)
    .setAudience(AUDIENCE)
    .setSubject(runId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(signingKey());
  return { token, expiresAt: expiresAt.toISOString(), context };
}

/** Verify signature, audience and expiry, then require the Run to be live. */
export async function verifyRunToken(token: string): Promise<RunTokenContext> {
  let claims: z.infer<typeof claimsSchema>;
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      algorithms: ['HS256'],
      issuer: getPlatformEnv().appUrl,
      audience: AUDIENCE,
    });
    claims = claimsSchema.parse(payload);
  } catch {
    throw new CliError('invalid_token', 401);
  }
  const context = {
    runId: claims.sub,
    sessionId: claims.sid,
    runnerId: claims.rnr,
  };
  await requireLiveRun(context);
  return context;
}
