import { promises as fs } from 'node:fs';
import path from 'node:path';

const clientOutputDirectory = path.resolve(
  import.meta.dirname,
  '../dist/platform/public',
);

const serverOnlySentinels = [
  {
    label: 'database environment bootstrap',
    value: 'environment variable DATABASE_URL is not set',
  },
  {
    label: 'Postgres driver',
    value: 'PostgresJsDatabase',
  },
] as const;

async function javascriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return javascriptFiles(absolutePath);
      return entry.isFile() && /\.(?:m?js)$/.test(entry.name)
        ? [absolutePath]
        : [];
    }),
  );
  return files.flat();
}

const violations: string[] = [];
for (const file of await javascriptFiles(clientOutputDirectory)) {
  const source = await fs.readFile(file, 'utf8');
  for (const sentinel of serverOnlySentinels) {
    if (source.includes(sentinel.value)) {
      violations.push(
        `${path.relative(clientOutputDirectory, file)} contains ` +
          sentinel.label,
      );
    }
  }
}

if (violations.length > 0) {
  throw new Error(
    'Server-only database code reached the Platform client bundle:\n' +
      violations.map((violation) => `- ${violation}`).join('\n') +
      '\nKeep database access inside createServerFn handlers or a server-only ' +
      'module imported exclusively from those handlers.',
  );
}

console.log('Platform client bundle excludes server-only database code.');
