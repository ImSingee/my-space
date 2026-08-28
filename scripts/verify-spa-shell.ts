import { stat } from 'node:fs/promises';
import path from 'node:path';

const shellPath = path.resolve('dist/platform/public/_shell.html');

let shellStat;
try {
  shellStat = await stat(shellPath);
} catch (error) {
  throw new Error(`SPA shell was not generated at ${shellPath}`, {
    cause: error,
  });
}

if (!shellStat.isFile() || shellStat.size === 0) {
  throw new Error(`SPA shell is empty or invalid at ${shellPath}`);
}

console.log(`Verified SPA shell: ${shellPath}`);
