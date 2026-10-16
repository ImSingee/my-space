import { createDeployLock } from '~server/deploy-lock';

/** Shared App lifecycle lock; namespace 1 is distinct from Workflows. */
export const appDeployLock = createDeployLock(1);
