import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { DeploymentHistoryView } from './deployment-history';

test('shows why a database-dependent deployment cannot be restored', async () => {
  const onRollback = vi.fn<(deploymentId: string) => void>();
  const reason =
    'The app database was permanently deleted. Restore this deployment tag files onto current master and deploy as a new release.';
  const screen = await render(
    <MantineProvider>
      <DeploymentHistoryView
        deployments={[
          {
            id: 'deployment-v1',
            version: 1,
            status: 'deployed',
            message: 'Database version',
            error: null,
            createdAt: '2026-08-13T00:00:00.000Z',
            isCurrent: false,
            canRollback: false,
            rollbackBlockedReason: reason,
            sourceCommit: '0123456789abcdef',
            sourceTag: 'deploy/v1',
            hasArtifact: true,
            hasBuildLog: false,
          },
        ]}
        isLoading={false}
        emptyNoun="app"
        onRollback={onRollback}
        rollingId={null}
        renderArtifact={() => null}
        renderBuildLog={() => null}
      />
    </MantineProvider>,
  );

  await expect.element(screen.getByText(reason)).toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Restore' }))
    .toBeDisabled();
  expect(onRollback).not.toHaveBeenCalled();
});
