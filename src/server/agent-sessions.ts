/**
 * Agent conversation server functions.
 *
 * This module is import-reachable from `~queries/agent`. Keep every runtime
 * value that touches `db` inside a createServerFn handler so TanStack removes
 * it from the browser graph. Module-scope database helpers survive that
 * transform and pull the Postgres client into the root browser bundle.
 */
import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '~/db';
import { cancelAgentRun, getActiveAgentRun } from './agent-runs';
import { deleteAgentSessionAttachments } from './agent-attachments';
import { broadcastSessionWorkspaceCleanup } from './agent-runner/hub';
import { authMiddleware } from './auth';

export type { SessionSummary, SessionDetail } from './agent-session-store';
import {
  listSessionSummaries,
  loadSessionDetail,
  insertAgentSession,
} from './agent-session-store';

const listSessionsSchema = z.object({
  appId: z.string().min(1).optional(),
});

export const listSessions = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof listSessionsSchema> | undefined) =>
    listSessionsSchema.parse(input ?? {}),
  )
  .handler(({ data }) => listSessionSummaries(data));

export const getSession = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => z.string().parse(id))
  .handler(({ data: id }) => loadSessionDetail(id));

const createSchema = z.object({
  title: z.string().optional(),
  providerId: z.string().nullish(),
  modelId: z.string().nullish(),
});

export const createSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof createSchema>) => createSchema.parse(data))
  .handler(({ data }) => insertAgentSession(data));

export const renameSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string; title: string }) =>
    z.object({ id: z.string(), title: z.string().min(1) }).parse(data),
  )
  .handler(async ({ data }) => {
    await db
      .update(schema.agentSessions)
      .set({ title: data.title.trim() })
      .where(eq(schema.agentSessions.id, data.id));
    return { ok: true };
  });

export const setSessionModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string; providerId: string; modelId: string }) =>
    z
      .object({
        id: z.string(),
        providerId: z.string(),
        modelId: z.string(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    await db
      .update(schema.agentSessions)
      .set({ providerId: data.providerId, modelId: data.modelId })
      .where(eq(schema.agentSessions.id, data.id));
    return { ok: true };
  });

export const deleteSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => z.object({ id: z.ulid() }).parse(data))
  .handler(async ({ data }) => {
    // Abort (and wait for) any in-flight run first. Otherwise the deletion
    // cascades the run rows while its model/tool execution keeps going in the
    // background — still running shell commands, deploys, etc. after the chat is
    // gone — and late event inserts would hit already-deleted rows.
    const active = await getActiveAgentRun(data.id);
    if (active) await cancelAgentRun(active.id);
    await db
      .delete(schema.agentSessions)
      .where(eq(schema.agentSessions.id, data.id));
    broadcastSessionWorkspaceCleanup(data.id);
    await deleteAgentSessionAttachments(data.id);
    return { ok: true };
  });
