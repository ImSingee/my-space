/**
 * Verify the agent-generated Notes backend actually runs under Deno: lazy-start
 * it and exercise AddNote + ListNotes through the platform proxy.
 *
 * Run with: set -a && . ./.env.local && set +a && pnpm exec tsx scripts/verify-notes.ts
 */
import {
  ensureAppRunning,
  proxyAppRequest,
  stopApp,
} from '../src/server/apps/runtime';

const ID = 'notes';
const base = `http://platform/api/apps/${ID}/rpc`;
const strip = `/api/apps/${ID}/rpc`;

async function rpc(method: string, body: unknown) {
  const res = await proxyAppRequest(
    ID,
    new Request(`${base}/app.v1.NotesService/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    strip,
  );
  if (!res.ok) {
    throw new Error(`${method} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log('[lazy start]');
  const port = await ensureAppRunning(ID);
  console.log('  backend port', port);

  console.log('[AddNote]');
  const added = await rpc('AddNote', {
    title: 'Hello from verify',
    body: 'Written by the verify script.',
  });
  console.log('  ->', JSON.stringify(added));

  console.log('[ListNotes]');
  const list = await rpc('ListNotes', { limit: 5 });
  const notes = (list.notes ?? []) as Array<{ title: string }>;
  console.log('  -> count', notes.length, 'newest:', notes[0]?.title);

  if (!notes.some((n) => n.title === 'Hello from verify')) {
    throw new Error('added note not found in list');
  }

  console.log('\nPASS: agent-generated Notes backend runs and persists.');
  stopApp(ID);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nVERIFY FAILED:', e);
  stopApp(ID);
  process.exit(1);
});
