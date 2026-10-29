const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const platformApiRoot = path.resolve(
  __dirname,
  '../packages/hatch-platform-api',
);
// The shared ESM package uses .js specifiers for TypeScript sources. Metro
// does not apply TypeScript's extension substitution, so scope it to that
// package rather than changing generated files or third-party resolution.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isSharedSource = context.originModulePath.startsWith(
    `${platformApiRoot}${path.sep}`,
  );
  const sourceName =
    isSharedSource && moduleName.startsWith('.') && moduleName.endsWith('.js')
      ? `${moduleName.slice(0, -3)}.ts`
      : moduleName;
  return context.resolveRequest(context, sourceName, platform);
};
module.exports = config;
