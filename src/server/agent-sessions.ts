import { createServerFn } from '@tanstack/react-start';
import { desc, eq, sql } from 'drizzle-orm';
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
  appId: string | null;
  providerId: string | null;
  modelId: string | null;
  messageCount: number;
  updatedAt: string;
};

export const listSessions = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<SessionSummary[]> => {
    // Count messages in SQL: pulling every session's full messages JSONB just
    // to call .length made this list scale with total chat history size.
    const rows = await db
      .select({
        id: schema.agentSessions.id,
        title: schema.agentSessions.title,
        appId: schema.agentSessions.appId,
        providerId: schema.agentSessions.providerId,
        modelId: schema.agentSessions.modelId,
        messageCount: sql<number>`case
          when jsonb_typeof(${schema.agentSessions.messages}) = 'array'
          then jsonb_array_length(${schema.agentSessions.messages})
          else 0 end`,
        updatedAt: schema.agentSessions.updatedAt,
      })
      .from(schema.agentSessions)
      .orderBy(desc(schema.agentSessions.updatedAt));
    return rows.map((s) => ({
      id: s.id,
      title: s.title,
      appId: s.appId,
      providerId: s.providerId,
      modelId: s.modelId,
      messageCount: s.messageCount,
      updatedAt: s.updatedAt.toISOString(),
    }));
  });

export type SessionDetail = {
  id: string;
  title: string;
  appId: string | null;
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
      where: (s, { eq: e }) => e(s.id, id),
    });
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      appId: row.appId,
      providerId: row.providerId,
      modelId: row.modelId,
      updatedAt: row.updatedAt.toISOString(),
      messages: row.messages,
      activeRun: await getActiveAgentRun(row.id),
    };
  });

const createSchema = z.object({
  title: z.string().optional(),
  appId: z.string().nullish(),
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
        appId: data.appId ?? null,
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
  .validator((data: { id: string }) => z.object({ id: z.string() }).parse(data))
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
    return { ok: true };
  });
