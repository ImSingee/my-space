import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { appBuildDir } from '~agent/paths';
import { liveBuildMatchesDeployment } from './build-identity';
import { appCompatibility } from '~/app-compatibility';
import { db, schema } from '~/db';
import type {
  AppServiceAdvertisement,
  AppTailscaleConfig,
  AppTailscaleStatus,
} from '~/app-tailscale';

export async function advertisedAppServices(): Promise<
  AppServiceAdvertisement[]
> {
  const bindings = await db.query.appTailscaleServices.findMany({
    where: { enabled: true },
  });
  if (!bindings.length) return [];
  const apps = await db.query.apps.findMany({
    where: { id: { in: bindings.map((b) => b.appId) } },
  });
  const deployments = await db.query.deployments.findMany({
    where: {
      id: {
        in: apps.flatMap((a) =>
          a.currentDeploymentId ? [a.currentDeploymentId] : [],
        ),
      },
    },
  });
  const candidates = bindings.filter((b) => {
    const app = apps.find((a) => a.id === b.appId);
    const deployment = deployments.find(
      (d) => d.id === app?.currentDeploymentId,
    );
    return (
      app &&
      app.status !== 'archived' &&
      deployment &&
      deployment.manifestNormalized &&
      appCompatibility(deployment.compatibilityVersion).isSupported
    );
  });
  const available = await Promise.all(
    candidates.map(async (binding) => {
      const app = apps.find((a) => a.id === binding.appId)!;
      return (
        await stat(appBuildDir(app.id)).catch(() => null)
      )?.isDirectory() &&
        (await liveBuildMatchesDeployment(app.id, app.currentDeploymentId!))
        ? binding
        : null;
    }),
  );
  return available
    .filter((b) => b !== null)
    .map((b) => ({
      appId: b.appId,
      serviceName: b.serviceName,
      enabled: b.enabled,
      revision: b.revision,
    }));
}

export async function saveAppService(input: AppTailscaleConfig) {
  const app = await db.query.apps.findFirst({
    where: { id: input.appId },
    columns: { id: true },
  });
  if (!app) throw new Error('App not found');
  const { getTailscaleManager } = await import('../tailscale-manager');
  const manager = getTailscaleManager();
  return manager.mutateServices(async (hostname) => {
    if (input.serviceName === hostname) {
      throw new Error(
        'The service name must differ from the platform node name.',
      );
    }
    const previous = await db.query.appTailscaleServices.findFirst({
      where: { appId: input.appId },
    });
    if (
      previous?.serviceName === input.serviceName &&
      previous.enabled === input.enabled
    )
      return;
    await db
      .insert(schema.appTailscaleServices)
      .values({ ...input, revision: randomUUID() })
      .onConflictDoUpdate({
        target: schema.appTailscaleServices.appId,
        set: {
          serviceName: input.serviceName,
          enabled: input.enabled,
          revision: randomUUID(),
          updatedAt: new Date(),
        },
      })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'cause' in error &&
          error.cause &&
          typeof error.cause === 'object' &&
          'code' in error.cause &&
          error.cause.code === '23505'
        ) {
          throw new Error(
            'This service name is already assigned to another App.',
          );
        }
        throw error;
      });
  });
}

export async function appServiceStatus(
  appId: string,
): Promise<AppTailscaleStatus> {
  const { getTailscaleManager } = await import('../tailscale-manager');
  const manager = getTailscaleManager();
  const global = await manager.getStatus();
  const binding = await db.query.appTailscaleServices.findFirst({
    where: { appId },
  });
  const config = binding
    ? { appId, serviceName: binding.serviceName, enabled: binding.enabled }
    : null;
  const base = {
    config,
    origin: null,
    suffix: global.suffix ?? null,
    message: null,
  };
  if (!binding?.enabled) return { ...base, state: 'disabled' };
  if (!(await advertisedAppServices()).some((b) => b.appId === appId))
    return {
      ...base,
      state: 'unavailable',
      message: 'This App has no supported live deployment.',
    };
  if (global.state !== 'connected')
    return {
      ...base,
      state: 'disconnected',
      message: 'Connect the platform to Tailscale first.',
    };
  const observed = manager.serviceSnapshot(appId);
  return observed
    ? { ...base, ...observed, config, origin: observed.origin || null }
    : { ...base, state: 'starting' };
}

/** Revalidate persisted identity and live deployment on every ingress request. */
export async function activeAppService(appId: string, origin: string) {
  const { getTailscaleManager } = await import('../tailscale-manager');
  const observed = getTailscaleManager().serviceSnapshot(appId);
  if (observed?.state !== 'ready' || observed.origin !== origin) return null;
  const binding = await db.query.appTailscaleServices.findFirst({
    where: { appId, enabled: true, serviceName: observed.serviceName },
  });
  if (!binding || binding.revision !== observed.revision) return null;
  const app = await db.query.apps.findFirst({ where: { id: appId } });
  if (!app || app.status === 'archived' || !app.currentDeploymentId)
    return null;
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId },
  });
  if (
    !deployment ||
    !deployment.manifestNormalized ||
    !(await stat(appBuildDir(appId)).catch(() => null))?.isDirectory() ||
    !(await liveBuildMatchesDeployment(appId, deployment.id)) ||
    !appCompatibility(deployment.compatibilityVersion).isSupported
  )
    return null;
  return { binding, app, deployment };
}
