import { ensureAppDatabase } from './provision';

export async function appDatabaseRuntimeEnv(
  id: string,
  enabled: boolean,
): Promise<Record<string, string>> {
  if (!enabled) return {};
  const url = await ensureAppDatabase(id);
  return { DATABASE_URL: url };
}
