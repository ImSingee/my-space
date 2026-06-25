import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '~/db';
import type { JsonValue } from '~/db/schema';

export type SessionSummary = {
  id: string;
  title: string;
  appId: string | null;
  providerId: string | null;
  modelId: string | null;
  messageCount: number;
  updatedAt: string;
};

export const listSessions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionSummary[]> => {
    const rows = await db.query.agentSessions.findMany({
      orderBy: (s, { desc }) => [desc(s.updatedAt)],
    });
    return rows.map((s) => ({
      id: s.id,
      title: s.title,
      appId: s.appId,
      providerId: s.providerId,
      modelId: s.modelId,
      messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
      updatedAt: s.updatedAt.toISOString(),
    }));
  },
);

export type SessionDetail = {
  id: string;
  title: string;
  appId: string | null;
  providerId: string | null;
  modelId: string | null;
  messages: JsonValue[];
};

export const getSession = createServerFn({ method: 'GET' })
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
      messages: row.messages,
    };
  });

const createSchema = z.object({
  title: z.string().optional(),
  appId: z.string().nullish(),
  providerId: z.string().nullish(),
  modelId: z.string().nullish(),
});

export const createSession = createServerFn({ method: 'POST' })
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
  .validator((data: { id: string }) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => {
    await db
      .delete(schema.agentSessions)
      .where(eq(schema.agentSessions.id, data.id));
    return { ok: true };
  });
