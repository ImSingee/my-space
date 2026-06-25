/**
 * Minimal standard 5-field cron parser + next-run calculator.
 * Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6, 0=Sun).
 * Supports: `*`, `a`, `a-b`, `a,b,c`, `* / n` (steps), and combinations.
 */
type Field = { min: number; max: number };

const FIELDS: Field[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week
];

function parseField(spec: string, field: Field): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron step in "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === '') {
      lo = field.min;
      hi = field.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number.parseInt(a, 10);
      hi = Number.parseInt(b, 10);
    } else {
      lo = hi = Number.parseInt(rangePart, 10);
    }
    if (
      !Number.isInteger(lo) ||
      !Number.isInteger(hi) ||
      lo < field.min ||
      hi > field.max ||
      lo > hi
    ) {
      throw new Error(`Invalid cron range in "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export type CronSpec = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when both day-of-month and day-of-week are restricted (OR semantics). */
  domRestricted: boolean;
  dowRestricted: boolean;
};

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields, got ${parts.length}: "${expression}"`,
    );
  }
  return {
    minute: parseField(parts[0], FIELDS[0]),
    hour: parseField(parts[1], FIELDS[1]),
    dom: parseField(parts[2], FIELDS[2]),
    month: parseField(parts[3], FIELDS[3]),
    dow: parseField(parts[4], FIELDS[4]),
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function matches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes())) return false;
  if (!spec.hour.has(d.getHours())) return false;
  if (!spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  // Standard cron: when both are restricted, match if EITHER matches.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/** Next fire time strictly after `from`, or null if none within ~400 days. */
export function nextRun(spec: CronSpec, from: Date = new Date()): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const cap = 400 * 24 * 60; // minutes
  for (let i = 0; i < cap; i++) {
    if (matches(spec, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
