import { eq } from 'drizzle-orm';
import { clampRefreshSeconds } from '../../packages/hatch-platform-api/dashboard-refresh';
import { db, schema } from '~/db';
import { AppError } from './errors';

/** Web and native clients persist the same Dashboard refresh preference. */
export async function updateDashboardAutoRefresh(id: string, value: number) {
  const seconds = clampRefreshSeconds(value);
  const [updated] = await db
    .update(schema.dashboards)
    .set({ autoRefresh: seconds })
    .where(eq(schema.dashboards.id, id))
    .returning({ id: schema.dashboards.id });
  if (!updated) throw new AppError('Dashboard not found', 404);
  return { seconds };
}
