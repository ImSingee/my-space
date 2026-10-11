/** Client-neutral SDK payload, always taken from this running platform build. */
import platformPackage from '../../../package.json' with { type: 'json' };
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '~agent/paths';
import { PLATFORM_APP_BUF_GEN_YAML } from '~agent/app-codegen';
import {
  APP_SDK,
  LEGACY_DATA_SDK,
  WORKFLOW_SDK,
  sdkImports,
} from '../../../sdk-internal/definitions';

export async function sdkPayload(kind: 'app' | 'workflow') {
  const definitions =
    kind === 'app' ? [APP_SDK, LEGACY_DATA_SDK] : [WORKFLOW_SDK];
  const files: { path: string; contentBase64: string }[] = [];
  async function walk(root: string, relative: string, destination: string) {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(root, child, destination);
      else if (entry.isFile())
        files.push({
          path: `${destination}/${child}`,
          contentBase64: (await readFile(path.join(root, child))).toString(
            'base64',
          ),
        });
      else throw new Error('SDK build contains a non-regular entry.');
    }
  }
  for (const definition of definitions) {
    const root = path.join(REPO_ROOT, 'sdk-internal', definition.directory);
    const destination = `sdk/${definition.manifest.name}`;
    files.push({
      path: `${destination}/package.json`,
      contentBase64: (await readFile(path.join(root, 'package.json'))).toString(
        'base64',
      ),
    });
    await walk(root, 'dist', destination);
  }
  files.push({
    path: 'import-map.json',
    contentBase64: Buffer.from(
      JSON.stringify({ imports: sdkImports(definitions) }, null, 2),
    ).toString('base64'),
  });
  if (kind === 'app')
    files.push({
      path: 'buf.gen.yaml',
      contentBase64: Buffer.from(PLATFORM_APP_BUF_GEN_YAML).toString('base64'),
    });
  return {
    files,
    ...(kind === 'app'
      ? {
          tooling: {
            bufVersion: platformPackage.devDependencies[
              '@bufbuild/buf'
            ].replace(/^\^/, ''),
            protocGenEsVersion: platformPackage.devDependencies[
              '@bufbuild/protoc-gen-es'
            ].replace(/^\^/, ''),
          },
        }
      : {}),
  };
}
