/** Public stdin contract: chunk boundaries must not change authored JSON. */
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

async function stdinInput(bytes: Buffer, split: number) {
  const module = new URL('./input.ts', import.meta.url).href;
  const script = `import {readInput} from ${JSON.stringify(module)};
    process.send({ready:true});
    try { console.log(JSON.stringify(await readInput('-',new AbortController().signal))); }
    catch(error){ console.log(JSON.stringify({error:error.code})); process.exitCode=error.exitCode; }`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) throw new Error('Missing fixture pipes');
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk;
  });
  stderr.resume();
  child.once('message', () => {
    stdin.write(bytes.subarray(0, split));
    setTimeout(() => stdin.end(bytes.subarray(split)), 100);
  });
  stdin.on('error', () => {});
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, data: JSON.parse(output) };
}

it('preserves UTF-8 JSON across stdin chunks and enforces the byte limit', async () => {
  const input = { slug: 'fixture', name: '中文😀', description: 'Café' };
  const bytes = Buffer.from(JSON.stringify(input));
  const result = await stdinInput(bytes, bytes.indexOf(Buffer.from('中')) + 1);
  expect(result.data).toEqual(input);
  expect(result.code).toBe(0);
  const oversized = await stdinInput(
    Buffer.from(JSON.stringify({ name: '中'.repeat(5500) })),
    10,
  );
  expect(oversized.data.error).toBe('input_too_large');
  expect(oversized.code).toBe(2);
});
