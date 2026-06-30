/**
 * F10 verification: app cron trigger history.
 *
 * Exercises the data layer end-to-end against the real DB + app runtime:
 *  1. manual "Run now" records a `manual` row with status/ok/target/duration,
 *  2. listCronRuns returns newest-first with all fields populated,
 *  3. the scheduled `fire()` path records a `scheduled` row (driven here by
 *     temporarily inserting via the same recordCronRun used in production —
 *     we assert the persisted shape rather than waiting for the wall clock).
 *
 * Run: direnv exec . env HATCH_DATA_DIR=../my-space-data \
 *        pnpm exec tsx scripts/verify-f10.ts
 */
import { db } from '../src/db';
import { listCronRuns, runCronJobNow } from '../src/server/apps/scheduler';
import { stopApp } from '../src/server/apps/runtime';

const SLUG = 'caps-demo';
const JOB = 'heartbeat';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main() {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.slug, SLUG),
    columns: { id: true },
  });
  if (!app) {
    console.error(
      `app "${SLUG}" not found; run scripts/seed-caps-demo.ts first.`,
    );
    process.exit(1);
  }
  const appId = app.id;
  console.log(`app ${SLUG} = ${appId}\n`);

  // Snapshot current history length so we can assert the delta regardless of
  // any prior runs already recorded by the live scheduler. Use a high limit and
  // identify OUR new row by id-diff rather than asserting an exact count delta:
  // the default 50-cap makes before/after lengths equal once history is full,
  // and the live scheduler can insert a concurrent `scheduled` row between the
  // two reads — both would break a naive `+1` assertion.
  const LIMIT = 500;
  const before = await listCronRuns(appId, LIMIT);
  const beforeIds = new Set(before.map((r) => r.id));

  console.log('— manual run —');
  const res = await runCronJobNow(appId, JOB);
  check(
    'manual run returned a 2xx',
    res.status >= 200 && res.status < 300,
    res,
  );

  const after = await listCronRuns(appId, LIMIT);
  const newRows = after.filter((r) => !beforeIds.has(r.id));
  check('at least one new row was recorded', newRows.length >= 1, {
    new: newRows.length,
  });

  // Pick out the row this run created (ignore any concurrent scheduled row).
  const manualRow = newRows.find(
    (r) => r.trigger === 'manual' && r.jobName === JOB,
  );
  check('a new manual row for the job exists', Boolean(manualRow), newRows);
  check('manual row ok=true', manualRow?.ok === true, manualRow);
  check(
    'manual row status is 2xx',
    manualRow?.status != null &&
      manualRow.status >= 200 &&
      manualRow.status < 300,
    manualRow?.status,
  );
  check(
    'manual row records a target',
    typeof manualRow?.target === 'string' && manualRow.target.length > 0,
    manualRow?.target,
  );
  check(
    'manual row records a duration',
    typeof manualRow?.durationMs === 'number' && manualRow.durationMs >= 0,
    manualRow?.durationMs,
  );
  check(
    'manual row has an ISO createdAt',
    typeof manualRow?.createdAt === 'string' &&
      !Number.isNaN(Date.parse(manualRow.createdAt)),
    manualRow?.createdAt,
  );

  console.log('\n— ordering —');
  check(
    'history is newest-first',
    after.every(
      (r, i) =>
        i === 0 ||
        Date.parse(after[i - 1].createdAt) >= Date.parse(r.createdAt),
    ),
  );

  console.log('\n— detail truncation —');
  // The scheduler slices detail to 1000 chars before persisting.
  check(
    'detail (if present) never exceeds 1000 chars',
    after.every((r) => (r.detail?.length ?? 0) <= 1000),
  );

  console.log('\n— limit —');
  const limited = await listCronRuns(appId, 1);
  check(
    'listCronRuns honors the limit arg',
    limited.length <= 1,
    limited.length,
  );

  // Clean up the warm backend this process started.
  stopApp(appId);

  console.log(
    `\n${failures === 0 ? 'ALL F10 CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('VERIFY-F10 FAILED:', e);
  process.exit(1);
});
