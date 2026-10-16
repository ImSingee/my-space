/** Shared database operations for browser server functions and interactive HTTP clients. */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { JsonValue } from '~/db/schema';
import { nextUserTurn } from '~agent/user-turns';
import {
  getActiveAgentRun,
  listSessionRunTimings,
  type ActiveAgentRun,
  type SessionRunTiming,
} from './agent-runs';

export type SessionSummary = {
  id: string;
  title: string;
  appIds: string[];
  providerId: string | null;
  modelId: string | null;
  messageCount: number;
  updatedAt: string;
};

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
  /** Newest run per user turn, read in the same snapshot as `messages`. */
  runs: SessionRunTiming[];
  /** Server clock when the snapshot was read, for live timer alignment. */
  serverTime: string;
};

export async function listSessionSummaries(
  data: { appId?: string } = {},
): Promise<SessionSummary[]> {
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
}

export async function loadSessionDetail(
  id: string,
): Promise<SessionDetail | null> {
  // One snapshot for the transcript and its runs. A run that completes has
  // its transcript persisted before it turns `completed`, so a completed run
  // seen here guarantees `messages` holds its reply. Cancellation and
  // interruption can turn a run terminal before (or without) its partial
  // transcript; the chat waits for the reply itself in those cases.
  return db.transaction(
    async (tx) => {
      const row = await tx.query.agentSessions.findFirst({
        where: { id },
      });
      if (!row) return null;
      const [associations, active, runs] = await Promise.all([
        tx
          .select({ appId: schema.agentSessionApps.appId })
          .from(schema.agentSessionApps)
          .where(eq(schema.agentSessionApps.sessionId, row.id)),
        getActiveAgentRun(row.id, tx),
        listSessionRunTimings(row.id, tx),
      ]);
      // A run created before runs recorded their user turn still answers the
      // last user message of this same snapshot: no other run can append one
      // while it is active.
      const lastUserTurn = nextUserTurn(row.messages) - 1;
      const activeRun =
        active && active.userTurn === null && lastUserTurn >= 0
          ? { ...active, userTurn: lastUserTurn }
          : active;
      return {
        id: row.id,
        title: row.title,
        appIds: associations.map((association) => association.appId).sort(),
        providerId: row.providerId,
        modelId: row.modelId,
        updatedAt: row.updatedAt.toISOString(),
        messages: row.messages,
        activeRun,
        runs,
        serverTime: new Date().toISOString(),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function insertAgentSession(data: {
  title?: string;
  providerId?: string | null;
  modelId?: string | null;
}) {
  const [row] = await db
    .insert(schema.agentSessions)
    .values({
      title: data.title?.trim() || 'New chat',
      providerId: data.providerId ?? null,
      modelId: data.modelId ?? null,
    })
    .returning();
  return { id: row.id };
}
