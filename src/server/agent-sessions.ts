/**
 * Agent conversation server functions.
 *
 * This module is import-reachable from `~queries/agent`. Keep every runtime
 * value that touches `db` inside a createServerFn handler so TanStack removes
 * it from the browser graph. Module-scope database helpers survive that
 * transform and pull the Postgres client into the root browser bundle.
 */
import { createServerFn } from '@tanstack/react-start';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '~/db';
import type { JsonValue } from '~/db/schema';
import {
  cancelAgentRun,
  getActiveAgentRun,
  type ActiveAgentRun,
} from './agent-runs';
import { authMiddleware } from './auth';

export type SessionSummary = {
  id: string;
  title: string;
  appIds: string[];
  providerId: string | null;
  modelId: string | null;
  messageCount: number;
  updatedAt: string;
};

const listSessionsSchema = z.object({
  appId: z.string().min(1).optional(),
});

export const listSessions = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof listSessionsSchema> | undefined) =>
    listSessionsSchema.parse(input ?? {}),
  )
  .handler(async ({ data }): Promise<SessionSummary[]> => {
    // Count messages in SQL: pulling every session's full messages JSONB just
    // to call .length made this list scale with total chat history size.
    const selection = {
      id: schema.agentSessions.id,
      title: schema.agentSessions.title,
      providerId: schema.agentSessions.providerId,
      modelId: schema.agentSessions.modelId,
      messageCount: sql<number>`case
        when jsonb_typeof(${schema.agentSessions.messages}) = 'array'
        then jsonb_array_length(${schema.agentSessions.messages})
        else 0 end`,
      updatedAt: schema.agentSessions.updatedAt,
    };
    const rows =
      data.appId !== undefined
        ? await db
            .select(selection)
            .from(schema.agentSessions)
            .innerJoin(
              schema.agentSessionApps,
              and(
                eq(schema.agentSessionApps.sessionId, schema.agentSessions.id),
                eq(schema.agentSessionApps.appId, data.appId),
              ),
            )
            .orderBy(desc(schema.agentSessions.updatedAt))
        : await db
            .select(selection)
            .from(schema.agentSessions)
            .orderBy(desc(schema.agentSessions.updatedAt));
    const associations =
      rows.length === 0
        ? []
        : await db
            .select({
              sessionId: schema.agentSessionApps.sessionId,
              appId: schema.agentSessionApps.appId,
            })
            .from(schema.agentSessionApps)
            .where(
              inArray(
                schema.agentSessionApps.sessionId,
                rows.map((row) => row.id),
              ),
            );
    const appIdsBySession = new Map<string, string[]>();
    for (const association of associations) {
      const appIds = appIdsBySession.get(association.sessionId) ?? [];
      appIds.push(association.appId);
      appIdsBySession.set(association.sessionId, appIds);
    }
    return rows.map((session) => ({
      id: session.id,
      title: session.title,
      appIds: (appIdsBySession.get(session.id) ?? []).sort(),
      providerId: session.providerId,
      modelId: session.modelId,
      messageCount: session.messageCount,
      updatedAt: session.updatedAt.toISOString(),
    }));
  });

export type SessionDetail = {
  id: string;
  title: string;
  appIds: string[];
  providerId: string | null;
  modelId: string | null;
  /** Changes whenever the persisted session is mutated; used as a Retry CAS. */
  updatedAt: string;
  messages: JsonValue[];
  activeRun: ActiveAgentRun | null;
};

export const getSession = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => z.string().parse(id))
  .handler(async ({ data: id }): Promise<SessionDetail | null> => {
    const row = await db.query.agentSessions.findFirst({
      where: { id },
    });
    if (!row) return null;
    const [associations, activeRun] = await Promise.all([
      db
        .select({ appId: schema.agentSessionApps.appId })
        .from(schema.agentSessionApps)
        .where(eq(schema.agentSessionApps.sessionId, row.id)),
      getActiveAgentRun(row.id),
    ]);
    return {
      id: row.id,
      title: row.title,
      appIds: associations.map((association) => association.appId).sort(),
      providerId: row.providerId,
      modelId: row.modelId,
      updatedAt: row.updatedAt.toISOString(),
      messages: row.messages,
      activeRun,
    };
  });

const createSchema = z.object({
  title: z.string().optional(),
  providerId: z.string().nullish(),
  modelId: z.string().nullish(),
});

export const createSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof createSchema>) => createSchema.parse(data))
  .handler(async ({ data }) => {
    const [row] = await db
      .insert(schema.agentSessions)
      .values({
        title: data.title?.trim() || 'New chat',
        providerId: data.providerId ?? null,
        modelId: data.modelId ?? null,
      })
      .returning();
    return { id: row.id };
  });

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
    const [{ deleteAgentSessionAttachments }, hub] = await Promise.all([
      import('./agent-attachments'),
      import('./agent-runner/hub'),
    ]);
    await db
      .delete(schema.agentSessions)
      .where(eq(schema.agentSessions.id, data.id));
    hub.broadcastSessionWorkspaceCleanup(data.id);
    await deleteAgentSessionAttachments(data.id);
    return { ok: true };
  });
